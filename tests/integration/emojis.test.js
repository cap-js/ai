const cds = require("@sap/cds")
const path = require("path")

const app = path.join(__dirname, "../bookshop/")
const { test, GET } = cds.test(app)

describe("Tests for emojis being added over the API", () => {
  beforeEach(async () => {
    await test.data.reset()
  })

  describe("Development Profile Tests", () => {
    it("should add either 😀 or 😃 to the title of a book", async () => {
      const bookId = 201

      const { data: book } = await GET(`/odata/v4/catalog/Books(ID=${bookId})`)

      const validEmojis = ["\ude03", "\ude00", "\ude0d", "\ude07"]
      const lastChar = book.title.slice(-1)
      console.log({ validEmojis, lastChar })
      expect(validEmojis.includes(lastChar)).toBe(true)
    })
  })
})
