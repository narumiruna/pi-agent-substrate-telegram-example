import { describe, expect, it } from "vitest"
import { splitTelegramText } from "../src/gateway/delivery.js"

describe("bounded Telegram plain text chunks", () => {
  it("preserves exact plain text without formatting or truncation", () => {
    const text = "<b>not HTML</b> *not Markdown*\n".repeat(500)
    const chunks = splitTelegramText(text)
    expect(chunks.join("")).toBe(text)
    expect(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 4096)).toBe(true)
  })

  it("does not split a surrogate pair at the UTF-16 limit", () => {
    const text = `${"a".repeat(4095)}😀${"b".repeat(4094)}😀end`
    const chunks = splitTelegramText(text)
    expect(chunks.join("")).toBe(text)
    expect(chunks[0].length).toBe(4095)
    expect(chunks.every((chunk) => chunk.isWellFormed() && chunk.length <= 4096)).toBe(true)
    expect(splitTelegramText("😀".repeat(4096)).map((chunk) => chunk.length)).toEqual([4096, 4096])
  })

  it("handles empty output and exact bounds, and rejects unpaired surrogates", () => {
    expect(splitTelegramText("")).toEqual([])
    expect(splitTelegramText("a".repeat(4096))).toEqual(["a".repeat(4096)])
    expect(splitTelegramText("a".repeat(4097)).map((chunk) => chunk.length)).toEqual([4096, 1])
    expect(() => splitTelegramText("a\ud800b")).toThrow("Unicode")
  })
})
