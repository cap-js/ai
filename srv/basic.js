const cds = require("@sap/cds")

module.exports = class BasicService extends cds.Service {
  emojis = ["😀", "😃"]

  getRandomEmoji() {
    return this.emojis[Math.floor(Math.random() * this.emojis.length)]
  }
}
