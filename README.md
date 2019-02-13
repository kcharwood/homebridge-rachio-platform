# homebridge-rachio-platform

Rachio plugin for Homebridge

# Installtion

1. Install homebridge using: `npm install -g homebridge`
2. Install this plugin using: `npm install -g homebridge-rachio-platform`
3. Update your configuration file. See `sample-config.json` snippet below.

# Webhook Support
`homebridge-rachio-platform` uses webhooks in to update Homekit accessory status in Real-Time when a Rachio schedule is executing. If webhooks are not enabled, Homekit will not update when a Rachio schedule is running.

In order to support webhooks, you must know your external network IP address, and have the ability to open/forward a port from that IP address to your internal Homebridge server. Please do not file issues to this repository related to network configuration issues.

If no webhook information is provided in the config file, Homekit accessory status will not update if you interact with the Rachio controller outside of Homekit.

# API Key

You can acquire your API key from Rachio using this [documentation](https://rachio.readme.io/docs/authentication).

# Configuration

```json
{
  "platform": "Rachio-Platform",
  "name": "Rachio Controller",
  "api_key": {API_KEY_OBTAINED_FROM_RACHIO},
  "internal_webhook_port": 27546, //Optional, any available port on your homebridge server. 
  "external_webhook_address": "http://173.452.132.342:12453"// Optional, your pubvlic facing network IP address and available port
}
```

