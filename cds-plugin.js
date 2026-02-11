const cds = require("@sap/cds")

// we register ourselves to the cds once served event

// a one-time event, emitted when all services have been bootstrapped and added to the express app

cds.once("served", async () => {
  // iterate over all services
  const emojiService = await cds.connect.to("emojis")

  for (let srv of cds.services) {
    // iterate over all entities

    if (!srv.entities) continue
    for (let entity of srv.entities) {
      // iterate over all elements in the entity and collect those with @randomEmoji annotation

      const emojiElements = []

      for (const key in entity.elements) {
        const element = entity.elements[key]

        // check if there is an annotation called randomEmoji on the element

        if (element["@randomEmoji"]) emojiElements.push(element.name)
      }

      if (emojiElements.length) {
        // register a new handler on the service, that is called before every read operation

        srv.before("READ", entity, (req) => {
          const emoji = emojiService.getRandomEmoji()
          // modify the request query to append the emoji to the title field

          req.query.SELECT.columns = req.query.SELECT.columns.filter(
            (col) => !(col.ref && col.ref.includes("title")),
          )
          req.query.SELECT.columns.push({
            xpr: [
              { ref: ["title"] },
              "||",
              {
                xpr: ["case", "when", "true", "then", { val: emoji }, "end"],
              },
            ],
            as: "title",
            cast: { type: "cds.String" },
          })
        })
      }
    }
  }
})
