const cds = require("@sap/cds")

module.exports = class ProdService extends cds.Service {
  emojis = ["😇", "😍"]

  getRandomEmoji() {
    return this.emojis[Math.floor(Math.random() * this.emojis.length)]
  }
}
