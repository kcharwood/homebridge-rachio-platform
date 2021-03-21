# homebridge-rachio-platform

Rachio plugin for Homebridge

<p align="center">
  <img width=300 src="https://github.com/kcharwood/homebridge-rachio-platform/blob/master/docs/example.gif?raw=true">
</p>


# Installation

1. Install homebridge using: `npm install -g homebridge`
2. Install this plugin using: `npm install -g homebridge-rachio-platform`
3. Update your configuration file. See `sample-config.json` snippet below.

# Webhook Support
`homebridge-rachio-platform` uses webhooks to update Homekit accessory status in real-time when a Rachio schedule is executing.

In order to support webhooks, you must know your external network IP address, and have the ability to open/forward a port from that IP address to your internal Homebridge server (typically a modem or router on your local network). Please do not file issues to this repository related to network configuration issues.

Consult the log during setup. The plugin will print out a URL that can be used to test and confirm port forwarding is set up correctly.

If you see log messages like `Webhook received from an unknown external id`, you may set the `clear_previous_webhooks` flag to `true` to remove previous webhooks before creating or updating the webhook for this plugin. Note: this will clear all webhooks tied to your Rachio API key, so be careful if you rely on Rachio webhooks apart from this plugin.

# API Key

You can acquire your API key from Rachio using this [documentation](https://rachio.readme.io/docs/authentication).

# Configuration

```json
{
  "platform": "Rachio-Platform",
  "name": "Rachio Controller",
  "api_key": "{API_KEY_OBTAINED_FROM_RACHIO}",
  "internal_webhook_port": 27546, 
  "external_webhook_address": "http://173.452.132.342:12453",
  "clear_previous_webhooks": false
}
```
