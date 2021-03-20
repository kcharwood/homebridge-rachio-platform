/* eslint-disable camelcase */

const axios = require('axios')
const http = require('http')
const RachioClient = require('rachio')

let Accessory, Service, Characteristic

module.exports = function (homebridge) {
  console.log('homebridge API version: ' + homebridge.version)

  // Accessory must be created from PlatformAccessory Constructor
  Accessory = homebridge.platformAccessory

  // Service and Characteristic are from hap-nodejs
  Service = homebridge.hap.Service
  Characteristic = homebridge.hap.Characteristic

  // For platform plugin to be considered as dynamic platform plugin,
  // registerPlatform(pluginName, platformName, constructor, dynamic), dynamic must be true
  homebridge.registerPlatform('homebridge-rachio-platform', 'Rachio-Platform', RachioPlatform)
}

// Platform constructor
// config may be null
// api may be null if launched from old homebridge version
class RachioPlatform {
  constructor (log, config, api) {
    log('RachioPlatform Init')
    const platform = this
    this.log = log
    this.config = config

    this.accessories = [] // Array of all Homekit accessories (1 for each Rachio controller and each zone)
    this.activeZones = {} // map of active zones across all controllers, keyed by the zone's id

    const { name, api_key, internal_webhook_port, external_webhook_address } = this.config

    if (!api_key) {
      this.log.error('api_key is required in order to communicate with the Rachio API')
    }

    this.client = new RachioClient(api_key)

    if (external_webhook_address && internal_webhook_port) {
      // Init webhook
      this.webhook_key = 'Homebridge-' + name
      this.requestServer = http.createServer((request, response) => {
        // handle webhook events
        if (request.method === 'GET' && request.url === '/test') {
          platform.log('Test received. Webhooks are successfully configured!')
          response.writeHead(200)
          response.write('Webhooks are configured correctly!')
          return response.end()
        } else if (request.method === 'POST' && request.url === '/') {
          let body = []

          request.on('data', (chunk) => {
            body.push(chunk)
          }).on('end', () => {
            try {
              body = Buffer.concat(body).toString().trim()
              const jsonBody = JSON.parse(body)
              platform.log.debug('webhook request received: ' + jsonBody)

              if (jsonBody.externalId === this.webhook_key) {
                if (jsonBody.type === 'ZONE_STATUS') {
                  if (jsonBody.subType === 'ZONE_STOPPED' || jsonBody.subType === 'ZONE_COMPLETED') {
                    platform.log('Zone Stop Webhook received for ' + jsonBody.zoneId)
                    platform.updateZoneStopped(jsonBody.zoneId)
                  } else if (jsonBody.subType === 'ZONE_STARTED') {
                    platform.log('Zone Started Webhook received for ' + jsonBody.zoneId + ' for duration ' + jsonBody.duration)
                    platform.updateZoneRunning(jsonBody.zoneId, jsonBody.duration)
                  } else {
                    platform.log('Unhandled zone status ' + jsonBody.subtype)
                  }
                } else {
                  platform.log.warn('Unhandled event type ' + jsonBody.type)
                }
              } else {
                platform.log.warn('Webhook received from an unknown external id ' + jsonBody.externalId)
              }

              response.writeHead(204)
              return response.end()
            } catch (err) {
              platform.log('Error parsing webhook request ' + err)
              response.writeHead(404)
              return response.end()
            }
          })
        } else {
          platform.log.warn('Unsupported HTTP Request ' + request.method + ' ' + request.url)
          response.writeHead(404)
          return response.end()
        }
      })

      this.requestServer.listen(internal_webhook_port, function () {
        platform.log('Rachio Webhook Server listening on port ' + internal_webhook_port + '. Ensure that ' + external_webhook_address + ' is forwarding to this port.')
      })
    } else {
      this.log.warn('Webhook support is disabled. Consult the README for information on how to enable webhooks. This plugin will not update Homekit in realtime using events occurring outside of Homekit until you have configured webhooks.')
    }

    if (api) {
      // Save the API object as plugin needs to register new accessory via this object
      this.api = api

      // Listen to event "didFinishLaunching", this means homebridge already finished loading cached accessories.
      // Platform Plugin should only register new accessory that doesn't exist in homebridge after this event.
      // Or start discover new accessories.
      this.api.on('didFinishLaunching', function () {
        platform.log('Rachio-Platform DidFinishLaunching')
      })
    }

    this.refreshDevices()
  }

  async refreshDevices () {
    try {
      this.log('Refreshing Rachio devices...')

      // Refresh all Rachio devices (and zones) associated with the api_key
      const devices = await this.client.getDevices()
      for (const device of devices) {
        this.log(`Loading Rachio device: ${device.name} - ${device.id}`)

        const cachedDevice = this.accessories.find(accessory => accessory.UUID === device.id)
        let accessory
        if (cachedDevice) {
          this.log('Device ' + device.name + ' is cached')
          accessory = cachedDevice
        } else {
          accessory = this.addDevice(device)
        }

        accessory
          .getService(Service.AccessoryInformation)
          .setCharacteristic(Characteristic.Manufacturer, 'Rachio')
          .setCharacteristic(Characteristic.Model, device.model)
          .setCharacteristic(Characteristic.SerialNumber, device.serialNumber)

        // Get all the zones for this Rachio device and sort by zone number
        let zones = await device.getZones()
        zones = zones.sort(function (a, b) {
          return a.zoneNumber - b.zoneNumber
        })

        for (const zone of zones) {
          const cachedZone = this.accessories.find(accessory => accessory.UUID === zone.id)

          if (cachedZone) {
            this.log('Zone ' + zone.name + ' is cached')
            if (zone.enabled) {
              this.updateZoneAccessory(cachedZone, zone)
            } else {
              this.log('Removing Zone Number ' + zone.zoneNumber + ' because it is disabled.')
              this.api.unregisterPlatformAccessories('homebridge-rachio-platform', 'Rachio-Platform', [cachedZone])
            }
          } else if (zone.enabled) {
            this.addZone(zone)
          } else {
            this.log('Skipping Zone Number ' + zone.zoneNumber + ' because it is disabled.')
          }
        }

        // Determine which zone (if any) is active for this Rachio controller
        const activeZone = await device.getActiveZone()
        this.log.debug('Active zone for device ' + device.id + ': ' + (activeZone && activeZone.id))
        if (activeZone) this.activeZones[activeZone.id] = true

        this.configureWebhooks(this.config.external_webhook_address, device.id)
      }
      this.log('Devices refreshed')
    } catch (e) {
      this.log.error('Failed to refresh devices.', e)
    }
  }

  async upsertWebhook (device_id, webhook) {
    // Create or update a webhook
    const platform = this
    const { api_key, external_webhook_address } = this.config

    const req = {
      method: 'post',
      url: 'https://api.rach.io/1/public/notification/webhook/',
      headers: { Authorization: 'Bearer ' + api_key, 'Content-Type': 'application/json' },
      responseType: 'json',
      data: {
        externalId: this.webhook_key,
        url: external_webhook_address,
        eventTypes: [{ id: 5 }, { id: 10 }],
        device: { id: device_id }
      }
    }

    if (webhook) {
      this.log('Updating Webhook for ' + external_webhook_address)
      req.method = 'put'
      req.data.id = webhook.id
    } else {
      this.log('Creating Webhook for ' + external_webhook_address)
    }

    this.log.debug('upsert webhook:', JSON.stringify(req, null, 2))

    const response = await axios(req)
      .catch(err => {
        platform.log.error('Error upserting webhook ' + webhook.id + ': ' + err)
      })

    const test_webhook_url = encodeURI('https://httpbin.org/redirect-to?url=' + external_webhook_address + '/test')
    if (response && response.status === 200) {
      this.log('Successfully upserted webhook for ' + external_webhook_address + '. Navigate to ' + test_webhook_url + ' to ensure port forwarding is configured correctly.')
    }
  }

  async configureWebhooks (external_webhook_address, device_id) {
    const platform = this
    this.log.info('Configuring Rachio webhooks for ' + device_id)
    const webhookPrefix = 'https://api.rach.io/1/public/notification/'

    const { api_key, clear_previous_webhooks } = this.config

    let response = await axios({
      method: 'get',
      url: webhookPrefix + device_id + '/webhook',
      headers: { Authorization: 'Bearer ' + api_key, 'Content-Type': 'application/json' },
      responseType: 'json'
    }).catch(err => {
      platform.log.error('Error retrieving webhooks: ' + err)
    })

    const webhooks = response && response.data
    this.log.debug('GET /webhooks response:', JSON.stringify(webhooks, null, 2))
    if (!webhooks || !Array.isArray(webhooks)) return

    if (clear_previous_webhooks) {
      // cleanup any previous webhooks
      for (const oldWebhook of webhooks) {
        if (oldWebhook.externalId === this.webhook_key) continue // Skip the current webhook - we'll refresh it

        response = await axios({
          method: 'delete',
          url: webhookPrefix + 'webhook/' + oldWebhook.id,
          headers: { Authorization: 'Bearer ' + api_key, 'Content-Type': 'application/json' },
          responseType: 'json'
        }).catch(err => {
          platform.log.error('Error deleting old webhook ' + oldWebhook.id + ': ' + err)
        })

        if (response && response.status === 204) {
          platform.log.debug('Successfully deleted old webhook ' + oldWebhook.id)
        }
      }
    }

    const webhook = webhooks.find(wh => wh.externalId === this.webhook_key)
    return this.upsertWebhook(device_id, webhook)
  }

  async updateRemainingTimeForService (service) {
    this.log.debug('updateRemainingTimeForService')

    const remainingDuration = service.getCharacteristic(Characteristic.RemainingDuration).value
    const setDuration = Math.max(remainingDuration - 1, 0)
    this.log.debug('Remaining: ' + remainingDuration + ' Set Duration: ' + setDuration)

    if (remainingDuration !== setDuration) {
      this.log.debug('Setting Remaining Duration to ' + setDuration)
      service.setCharacteristic(Characteristic.RemainingDuration, setDuration, { reason: 'TIMER' })
    }
  }

  addDevice (device) {
    this.log('Add Device: ' + device.name)

    const newAccessory = new Accessory('Rachio Controller - ' + device.name, device.id)
    this.accessories.push(newAccessory)
    this.api.registerPlatformAccessories('homebridge-rachio-platform', 'Rachio-Platform', [newAccessory])

    return newAccessory
  }

  updateZoneRunning (zoneId, duration) {
    const zoneAccessory = this.accessories.find(a => a.UUID === zoneId)
    if (!zoneAccessory) return this.log.error('updateZoneRunning. Unknown zone: ' + zoneId)

    const service = zoneAccessory.getService(Service.Valve)
    if (!service.getCharacteristic(Characteristic.Active).value) {
      this.log('Updating zone status ' + zoneId + ' to in use and ' + duration + ' duration')
      service.getCharacteristic(Characteristic.Active).setValue(1, null, { reason: 'WEBHOOK' })
      service.setCharacteristic(Characteristic.InUse, 1)
      service.setCharacteristic(Characteristic.RemainingDuration, duration)
    }
  }

  updateZoneStopped (zoneId) {
    const zoneAccessory = this.accessories.find(a => a.UUID === zoneId)
    if (!zoneAccessory) return this.log.error('updateZoneStopped. Unknown zone: ' + zoneId)

    const service = zoneAccessory.getService(Service.Valve)
    if (service.getCharacteristic(Characteristic.Active).value) {
      this.log('Updating zone status ' + zoneId + ' to not in use and 0 remaining duration')
      service.getCharacteristic(Characteristic.Active).setValue(0, null, { reason: 'WEBHOOK' })
      service.setCharacteristic(Characteristic.InUse, 0)
      service.setCharacteristic(Characteristic.RemainingDuration, 0)
    }
  }

  updateZoneAccessory (accessory, zone) {
    const platform = this
    const client = this.client

    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Rachio')
      .setCharacteristic(Characteristic.Model, zone.customNozzle.name)
      .setCharacteristic(Characteristic.SerialNumber, zone.id)

    const service = accessory.getService(Service.Valve)

    service
      .getCharacteristic(Characteristic.InUse)
      .on('get', function (callback) {
        const isActive = platform.activeZones[accessory.UUID]
        platform.log.debug('get InUse value for ' + accessory.UUID + '. active: ' + !!isActive)
        callback(null, isActive ? 1 : 0)
      })

    service
      .getCharacteristic(Characteristic.Active)
      .on('get', function (callback) {
        const isActive = platform.activeZones[accessory.UUID]
        platform.log.debug('get active value for ' + accessory.UUID + '. active: ' + !!isActive)
        callback(null, isActive ? 1 : 0)
      })

    service
      .getCharacteristic(Characteristic.Active)
      .on('set', function (newValue, callback, context = {}) {
        if (context.reason !== 'WEBHOOK') {
          const service = accessory.getService(Service.Valve)
          if (newValue) {
            platform.log('active was set for ' + accessory.UUID)
            const duration = service.getCharacteristic(Characteristic.SetDuration).value || 300

            client.getZone(accessory.UUID)
              .then(zone => zone.start(duration))

            service.setCharacteristic(Characteristic.RemainingDuration, duration)
            service.setCharacteristic(Characteristic.InUse, 1)
          } else {
            platform.log('active was turned off for ' + accessory.UUID)
            service.setCharacteristic(Characteristic.RemainingDuration, 0)
            service.setCharacteristic(Characteristic.InUse, 0)

            client.getZone(accessory.UUID)
              .then(zone => zone.stop())
          }
        }

        // Update activeZones cache
        if (newValue) {
          platform.activeZones[zone.id] = true
        } else {
          delete platform.activeZones[zone.id]
        }

        callback(null)
      })

    service
      .getCharacteristic(Characteristic.RemainingDuration)
      .on('set', function (newValue, callback, context = {}) {
        platform.log.debug('Setting Remaining Duration: ' + newValue)
        if (newValue > 0) {
          platform.log.debug('Scheduling timer to reduce remaining duration')
          setTimeout(platform.updateRemainingTimeForService.bind(platform, service), 1000)
        }
        callback(null)
      })

    return accessory
  }

  addZone (zone) {
    this.log('Adding Zone: ' + zone.name)
    this.log.debug(zone)
    let newAccessory = new Accessory(zone.name, zone.id)

    newAccessory.addService(Service.Valve, zone.name)
    newAccessory
      .getService(Service.Valve)
      .setCharacteristic(Characteristic.ValveType, Characteristic.ValveType.IRRIGATION)
      .setCharacteristic(Characteristic.Name, zone.name)
    newAccessory = this.updateZoneAccessory(newAccessory, zone)

    const service = newAccessory.getService(Service.Valve)
    if (service.getCharacteristic(Characteristic.SetDuration).value === 0) {
      this.log.debug('Setting a default duration to ' + 300)
      service.setCharacteristic(Characteristic.SetDuration, 300)
      service.setCharacteristic(Characteristic.RemainingDuration, 0)
    }

    this.accessories.push(newAccessory)
    this.api.registerPlatformAccessories('homebridge-rachio-platform', 'Rachio-Platform', [newAccessory])

    return newAccessory
  }

  // Function invoked when homebridge tries to restore cached accessory.
  // Developer can configure accessory at here (like setup event handler).
  // Update current value.
  configureAccessory (accessory) {
    this.log('Configure Cached Accessory: ' + accessory.displayName)

    // Set the accessory to reachable if plugin can currently process the accessory,
    // otherwise set to false and update the reachability later by invoking
    // accessory.updateReachability()
    accessory.reachable = true

    this.accessories.push(accessory)
  }

  updateAccessoriesReachability () {
    this.log('Update Reachability')
    for (const accessory of this.accessories) {
      accessory.updateReachability(false)
    }
  }
}
