var request = require("request");
var Service, Characteristic;

module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  Accessory = homebridge.hap.Accessory;
  PlatformAccessory = homebridge.hap.PlatformAccessory;

  homebridge.registerPlatform("homebridge-rachio-sprinkler", "Rachio-Sprinkler", RachioPlatform);
}

function RachioPlatform(log, config, api) {

  this.log = log;
  this.config = config
  this.api = api;

  this.log("Setting Up Rachio");
  
  this.api_key = config["api_key"];
  
  this.log("Fetching Rachio devices...");
}

RachioPlatform.prototype.setupController = function() {
    this.log("Fetching Rachio devices...");
    const accessories = []
    request.get({
          url: "https://api.rach.io/1/public/person/info",
          headers: { "Authorization": "Bearer " + this.api_key}
        }, function(err, response, body) {
            var json = JSON.parse(body);
            this.person_id = json["id"]
            request.get({
                  url: "https://api.rach.io/1/public/person/" + this.person_id,
                  headers: { "Authorization": "Bearer " + this.api_key}
                }, function(err, response, body) {
                    var json = JSON.parse(body);
                    json["devices"].forEach(function (device) {
                        this.log("Setting up Rachio Controller for " + device["name"] + " (" + device["id"] + ")")
                        var rachioController = exports.accessories = new this.api.platformAccessory("Rachio Controller", device["id"]);

                        var rachioControllerInformationService = rachioController.getService(Service.AccessoryInformation)
                        rachioControllerInformationService.setCharacteristic(Characteristic.Name, device["name"])
                        rachioControllerInformationService.setCharacteristic(Characteristic.Manufacturer, "Rachio")
                        rachioControllerInformationService.setCharacteristic(Characteristic.Model, device["model"])
                        rachioControllerInformationService.setCharacteristic(Characteristic.SerialNumber, device["serialNumber"])

                        accessories.push(rachioController)
                        device['zones'].forEach(function (zone) {
                            if (zone["enabled"]) {
                                this.log(zone["name"])
                                var sprinkler = exports.accessory = new this.api.platformAccessory(zone["name"], zone["id"]);
                                var sprinklerService = sprinkler.addService(Service.Valve, "Sprinkler", )
                                sprinkler
                                 .getService(Service.Valve)
                                 .setCharacteristic(Characteristic.ValveType, "1")
                                 .setCharacteristic(Characteristic.Name, zone["name"]);
                                accessories.push(sprinkler)
                            }
                        }.bind(this))
                        this.log("Finished setting up accessories" + accessories)
                        callback(accessories)
                    }.bind(this))
                }.bind(this))
        }.bind(this))
}

RachioPlatform.prototype = {
    accessories: function (callback) {
        var rachioController = exports.accessories = new this.api.platformAccessory("Rachio Controller", "c0dea451-25dd-4b09-b3f6-3bb0469777ea");
        callback([rachioController])
    }
  // accessories: function (callback) {
  //   this.log("Fetching Rachio devices...");
  //   const accessories = []
  //   request.get({
  //         url: "https://api.rach.io/1/public/person/info",
  //         headers: { "Authorization": "Bearer " + this.api_key}
  //       }, function(err, response, body) {
  //           var json = JSON.parse(body);
  //           this.person_id = json["id"]
  //           request.get({
  //                 url: "https://api.rach.io/1/public/person/" + this.person_id,
  //                 headers: { "Authorization": "Bearer " + this.api_key}
  //               }, function(err, response, body) {
  //                   var json = JSON.parse(body);
  //                   json["devices"].forEach(function (device) {
  //                       this.log("Setting up Rachio Controller for " + device["name"] + " (" + device["id"] + ")")
  //                       var rachioController = exports.accessories = new this.api.platformAccessory("Rachio Controller", device["id"]);
  //
  //                       var rachioControllerInformationService = rachioController.getService(Service.AccessoryInformation)
  //                       rachioControllerInformationService.setCharacteristic(Characteristic.Name, device["name"])
  //                       rachioControllerInformationService.setCharacteristic(Characteristic.Manufacturer, "Rachio")
  //                       rachioControllerInformationService.setCharacteristic(Characteristic.Model, device["model"])
  //                       rachioControllerInformationService.setCharacteristic(Characteristic.SerialNumber, device["serialNumber"])
  //
  //                       accessories.push(rachioController)
  //                       device['zones'].forEach(function (zone) {
  //                           if (zone["enabled"]) {
  //                               this.log(zone["name"])
  //                               var sprinkler = exports.accessory = new this.api.platformAccessory(zone["name"], zone["id"]);
  //                               var sprinklerService = sprinkler.addService(Service.Valve, "Sprinkler", )
  //                               sprinkler
  //                                .getService(Service.Valve)
  //                                .setCharacteristic(Characteristic.ValveType, "1")
  //                                .setCharacteristic(Characteristic.Name, zone["name"]);
  //                               accessories.push(sprinkler)
  //                           }
  //                       }.bind(this))
  //                       this.log("Finished setting up accessories" + accessories)
  //                       callback(accessories)
  //                   }.bind(this))
  //               }.bind(this))
  //       }.bind(this))
  //   },
}
