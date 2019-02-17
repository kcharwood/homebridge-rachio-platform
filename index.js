var request = require("request");
var http = require('http');
const RachioClient = require("rachio");

var Service, Characteristic;

var Accessory, Service, Characteristic, UUIDGen;

module.exports = function(homebridge) {
    console.log("homebridge API version: " + homebridge.version);

    // Accessory must be created from PlatformAccessory Constructor
    Accessory = homebridge.platformAccessory;

    // Service and Characteristic are from hap-nodejs
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    UUIDGen = homebridge.hap.uuid;

    // For platform plugin to be considered as dynamic platform plugin,
    // registerPlatform(pluginName, platformName, constructor, dynamic), dynamic must be true
    homebridge.registerPlatform("homebridge-rachio-platform", "Rachio-Platform", RachioPlatform);
}

// Platform constructor
// config may be null
// api may be null if launched from old homebridge version
class RachioPlatform {
    constructor(log, config, api) {
        log("RachioPlatform Init");
        var platform = this;
        this.log = log;
        this.config = config;
        this.accessories = [];

        if (!this.config.api_key) {
            this.log.error("api_key is required in order to communicate with the rachio API")
        }

        this.client = new RachioClient(this.config.api_key);

        if (this.config.external_webhook_address && this.config.internal_webhook_port) {
            this.webhook_key = "Homebridge-" + this.config.name
            this.requestServer = http.createServer(function(request, response) {
                if (request.method == "GET" && request.url == "/test") {
                    this.log("Test received. Webhooks are successfully configured!")
                    response.writeHead(200);
                    response.write("Webhooks are configured correctly!");
                    response.end();
                }
                else if (request.method == "POST" && request.url == "/") {
            
                    let body = [];
                    request.on('data', (chunk) => {
                        body.push(chunk);
                    }).on('end', () => {
                        body = Buffer.concat(body).toString().trim();
                        try {
                            var jsonBody = JSON.parse(body);
                        }
                        catch (err){
                            this.log("Error parsing request " + err)
                            response.writeHead(404);
                            response.end();
                            return
                        }
                        
                        response.writeHead(204);
                        response.end();
                        this.log.debug(jsonBody)
                        if (jsonBody.externalId == this.webhook_key) {
                            if (jsonBody.type == "ZONE_STATUS") {
                                if (jsonBody.subType == "ZONE_STOPPED" || jsonBody.subType == "ZONE_COMPLETED") {
                                    this.log("Zone Stop Webhook Received for " + jsonBody.zoneId)
                                    this.updateZoneStopped(jsonBody.zoneId)
                                } else if  (jsonBody.subType == "ZONE_STARTED") {
                                    this.log("Zone Started Webhook Received for " + jsonBody.zoneId + " for duration " + jsonBody.duration)
                                    this.updateZoneRunning(jsonBody.zoneId, jsonBody.duration)
                                } else {
                                    this.log("Unhandled zone status " + jsonBody.subtype)
                                }
                            } else {
                                this.log.warn("Unhandled event type " + jsonBody.type)
                            }
                        } else {
                            this.log.warn("Webhook Recieved from an unknown external id " + jsonBody.externalId)
                        }

                    });
                } else {
                    this.log.warn("Unsupported HTTP Request " + request.method + " " + request.url)
                    response.writeHead(404);
                    response.end();
                }
            }.bind(this));

            var internal_webhook_port = this.config.internal_webhook_port
            var external_webhook_address = this.config.external_webhook_address
            this.requestServer.listen(internal_webhook_port, function() {
                platform.log("Rachio Webhook Server Listening on port " + internal_webhook_port + ". Ensure that " + external_webhook_address + " is forwarding to this port.");
            });
        } else {
            this.log.warn("Webhook support is disabled. Consult the README for information on how to enable webhooks. This plugin will not update Homekit in realtime using events occuring outside of Homekit until you have configured webhooks.")
        }
        

        if (api) {
            // Save the API object as plugin needs to register new accessory via this object
            this.api = api;

            // Listen to event "didFinishLaunching", this means homebridge already finished loading cached accessories.
            // Platform Plugin should only register new accessory that doesn't exist in homebridge after this event.
            // Or start discover new accessories.
            this.api.on('didFinishLaunching', function() {
                platform.log("Rachio-Platform DidFinishLaunching");
            }.bind(this));
        }
        this.refreshDevices()
    }

    async refreshDevices() {
        try {
            this.log("Refreshing devices...");

            var hubs = await this.client.getDevices();

            var zonesMerge = [];
            var zones = [];
            var devices = []

            for (var i = 0; i < hubs.length; i++) {
                var hub = hubs[i];
                this.log(`Loading Rachio: ${hub.name} - ${hub.id}`);
                var device = await this.client.getDevice(hub.id);

                var cachedAccessory = this.accessories.filter(a => {
                    return a.UUID == device.id;
                });

                var accessory
                if (cachedAccessory[0]) {
                    this.log("Device " + device.name + " is cached")
                    accessory = cachedAccessory[0]
                } else {
                    accessory = this.addDevice(device)
                }
                accessory
                    .getService(Service.AccessoryInformation)
                    .setCharacteristic(Characteristic.Manufacturer, "Rachio")
                    .setCharacteristic(Characteristic.Model, device.model)
                    .setCharacteristic(Characteristic.SerialNumber, device.serialNumber);

                var zones = await device.getZones();
                zones = zones.sort(function(a, b) {
                    return a.zoneNumber - b.zoneNumber
                })
                for (var i = 0; i < zones.length; i++) {
                    var zone = zones[i]

                    var cachedAccessory = this.accessories.filter(a => {
                        return a.UUID == zone.id;
                    });

                    var zoneAccessory
                    if (cachedAccessory[0]) {
                        this.log("Zone " + zone.name + " is cached")
                        zoneAccessory = this.updateZoneAccessory(cachedAccessory[0], zone)
                    } else {
                        zoneAccessory = this.addZone(zone)
                    }
                }
                this.configureWebhooks(this.config.external_webhook_address, device.id)
            }
            this.log("Devices refreshed");
        } catch (e) {
            this.log.error("Failed to refresh devices.", e);
        }
    }
}


RachioPlatform.prototype.configureWebhooks = function(external_webhook_address, device_id) {
    this.log.info("Configuring rachio webhooks for " + device_id)
    request.get({
              url: "https://api.rach.io/1/public/notification/"+device_id+"/webhook",
              headers: { "Authorization": "Bearer " + this.config.api_key}
            }, function(err, response, body) {
                var webhooks = JSON.parse(body);
                var key = this.webhook_key
                
                this.log.debug(webhooks)
                
                var webhook = webhooks.filter(a => {
                    return a.externalId == key;
                });
                
                if (webhook[0]) {
                    this.log("Updating Webhook for " + external_webhook_address)
                    request.put({
                              url: "https://api.rach.io/1/public/notification/webhook",
                              headers: { "Authorization": "Bearer " + this.config.api_key, "Content-Type": "application/json"},
                              body: {"id": webhook[0].id, "externalId": key, "url": external_webhook_address, "eventTypes": [{"id": 5}, {"id": 10}], "device" : {"id": device_id}},
                              json: true
                            }, function(err, response, body) {
                                this.log.debug(response.statusCode)
                                this.log.debug(body)
                                if (response.statusCode == 200) {
                                    this.log("Successfully updated webhook for " + external_webhook_address + ". Navigate to " + external_webhook_address + "/test to ensure port forwarding is configured correctly.")
                                }
                        }.bind(this))
                } else {
                    this.log("Configuring new Webhook for " + external_webhook_address)
                    request.post({
                              url: "https://api.rach.io/1/public/notification/webhook",
                              headers: { "Authorization": "Bearer " + this.config.api_key, "Content-Type": "application/json"},
                              body: {"externalId": key, "url": external_webhook_address, "eventTypes": [{"id": 5}, {"id": 10}], "device" : {"id": device_id}},
                              json: true
                            }, function(err, response, body) {
                                this.log.debug(response.statusCode)
                                this.log.debug(body)
                                if (response.statusCode == 200) {
                                    this.log("Successfully added webhook for " + external_webhook_address + ". Navigate to " + external_webhook_address + "/test to ensure port forwarding is configured correctly.")
                                }
                        }.bind(this))
                }
            }.bind(this))
  }

RachioPlatform.prototype.updateRemainingTimeForService = function(service) {
    this.log.debug("updateRemainingTimeForService")
    remainingDuration = service.getCharacteristic(Characteristic.RemainingDuration).value
    setDuration = Math.max(remainingDuration - 1, 0)
    this.log.debug("Remaining: " + remainingDuration + " Set Duration: " + setDuration)
    if (remainingDuration != setDuration) {
        this.log.debug("Setting Remaining Duration to " + setDuration)
        service.setCharacteristic(Characteristic.RemainingDuration, setDuration, {"reason" : "TIMER"})
    }
}

// Function invoked when homebridge tries to restore cached accessory.
// Developer can configure accessory at here (like setup event handler).
// Update current value.
RachioPlatform.prototype.configureAccessory = function(accessory) {
    this.log("Configure Cached Accessory: " + accessory.displayName);
    var platform = this;

    // Set the accessory to reachable if plugin can currently process the accessory,
    // otherwise set to false and update the reachability later by invoking 
    // accessory.updateReachability()
    accessory.reachable = true;

    this.accessories.push(accessory);
}

RachioPlatform.prototype.addDevice = function(device) {
    this.log("Add Device: " + device.name);
    var platform = this;

    var newAccessory = new Accessory("Rachio Controller - " + device.name, device.id);

    this.accessories.push(newAccessory);
    this.api.registerPlatformAccessories("homebridge-rachio-platform", "Rachio-Platform", [newAccessory]);

    return newAccessory
}

RachioPlatform.prototype.updateZoneRunning = function(zoneId, duration) {
    let zoneAccessory = this.accessories.filter(a => {
        return a.UUID == zoneId;
    })[0];
    if (zoneAccessory) {
        service = zoneAccessory.getService(Service.Valve)
        if (!service.getCharacteristic(Characteristic.Active).value) {
            this.log("Updating zone status " + zoneId + " to in use and " + duration + " duration")
            service.getCharacteristic(Characteristic.Active).setValue(1, null, {"reason" : "WEBHOOK"})
            service.setCharacteristic(Characteristic.InUse, 1)
            service.setCharacteristic(Characteristic.RemainingDuration, duration)
        }
    }
}

RachioPlatform.prototype.updateZoneStopped = function(zoneId) {
    var zoneAccessory = this.accessories.filter(a => {
        return a.UUID == zoneId;
    })[0];
    if (zoneAccessory) {
        service = zoneAccessory.getService(Service.Valve)
        if (service.getCharacteristic(Characteristic.Active).value) {
            this.log("Updating zone status " + zoneId + " to not in use and 0 remaining duration")
            service.getCharacteristic(Characteristic.Active).setValue(0, null, {"reason" : "WEBHOOK"})
            service.setCharacteristic(Characteristic.InUse, 0)
            service.setCharacteristic(Characteristic.RemainingDuration, 0)
        }
    }
}

RachioPlatform.prototype.updateZoneAccessory = function(accessory, zone) {
    var client = this.client

    accessory
        .getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Manufacturer, "Rachio")
        .setCharacteristic(Characteristic.Model, zone.customNozzle.name)
        .setCharacteristic(Characteristic.SerialNumber, zone.id);

    service = accessory.getService(Service.Valve)
    logger = this.log
    that = this

    service
        .getCharacteristic(Characteristic.InUse)
        .on('get', function(callback) {
            logger.debug("get InUse value for " + accessory.UUID)
            var isWatering = client.getZone(accessory.UUID)
                .then(zone => zone.isWatering())
            callback(null, isWatering)
        });

    service
        .getCharacteristic(Characteristic.Active)
        .on('get', function(callback) {
            logger.debug("get active value for " + accessory.UUID)
            var isWatering = client.getZone(accessory.UUID)
                .then(zone => zone.isWatering())
            callback(null, isWatering)
        });


    service
        .getCharacteristic(Characteristic.Active)
        .on('set', function(newValue, callback, context) {
            if (context.reason != "WEBHOOK") {
                service = accessory.getService(Service.Valve)
                if (newValue) {
                    logger("active was set for " + accessory.UUID)
                    duration = service.getCharacteristic(Characteristic.SetDuration).value || 300

                    client.getZone(accessory.UUID)
                        .then(zone => zone.start(duration));

                    service.setCharacteristic(Characteristic.RemainingDuration, duration);
                    service.setCharacteristic(Characteristic.InUse, 1);
                } else {
                    logger("active was turned off for " + accessory.UUID)
                    service.setCharacteristic(Characteristic.RemainingDuration, 0);
                    service.setCharacteristic(Characteristic.InUse, 0)

                    client.getZone(accessory.UUID)
                        .then(zone => zone.stop());
                }
            }
            callback(null, 10);
        });

    service
        .getCharacteristic(Characteristic.RemainingDuration)
        .on('set', function(newValue, callback, context) {
            logger.debug("Setting Remaining Duration: " + newValue)
            if (newValue > 0) {
                logger.debug("Scheduling timer to reduce remaining duration")
                setTimeout(that.updateRemainingTimeForService.bind(that, service), 1000);
            }
            callback()
        });

    return accessory
}

RachioPlatform.prototype.addZone = function(zone) {
    this.log("Adding Zone: " + zone.name);
    this.log.debug(zone)
    var newAccessory = new Accessory(zone.name, zone.id);

    var sprinklerService = newAccessory.addService(Service.Valve, zone.name)
    newAccessory
        .getService(Service.Valve)
        .setCharacteristic(Characteristic.ValveType, Characteristic.ValveType.IRRIGATION)
        .setCharacteristic(Characteristic.Name, zone.name);

    newAccessory = this.updateZoneAccessory(newAccessory, zone)

    service = newAccessory.getService(Service.Valve)
    if (service.getCharacteristic(Characteristic.SetDuration).value == 0) {
        this.log.debug("Setting a default duration to " + 300)
        service.setCharacteristic(Characteristic.SetDuration, 300)
        service.setCharacteristic(Characteristic.RemainingDuration, 0)
    }
    
    this.accessories.push(newAccessory);
    this.api.registerPlatformAccessories("homebridge-rachio-platform", "Rachio-Platform", [newAccessory]);

    return newAccessory
}

RachioPlatform.prototype.updateAccessoriesReachability = function() {
    this.log("Update Reachability");
    for (var index in this.accessories) {
        var accessory = this.accessories[index];
        accessory.updateReachability(false);
    }
}

// Sample function to show how developer can remove accessory dynamically from outside event
RachioPlatform.prototype.removeAccessory = function() {
    this.log("Remove Accessory");
    this.api.unregisterPlatformAccessories("hhomebridge-rachio-platform", "Rachio-Platform", this.accessories);

    this.accessories = [];
}
