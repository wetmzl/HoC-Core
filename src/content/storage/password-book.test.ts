import { expect, it } from "vitest";
import { importPasswordCandidates, MAX_PASSWORDS, PASSWORD_BOOK_KEY, PasswordBook } from "./password-book";

it("persists locally, preserves spaces, deduplicates and supports deletion/clear", () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const book = new PasswordBook(storage);
  book.add(" space "); book.add(" space "); book.add("second");
  expect(new PasswordBook(storage).list()).toEqual([" space ", "second"]);
  book.remove(0); expect(book.list()).toEqual(["second"]);
  book.clear(); expect(data.size).toBe(0);
  expect(importPasswordCandidates(book.list())).toContain("welcome2hoc");
  for (let i = 0; i < MAX_PASSWORDS; i++) book.add(String(i));
  expect(() => book.add("overflow")).toThrow("已满");
  storage.setItem(PASSWORD_BOOK_KEY, "invalid"); expect(() => book.list()).toThrow();
  book.clear(); book.add("recovered"); expect(book.list()).toEqual(["recovered"]);
});

it("provides the built-in password to new and existing books without replacing personal passwords", () => {
  expect(importPasswordCandidates()).toContain("welcome2hoc");
  const personal = ["my-password", "welcome2hoc", " space "];
  expect(importPasswordCandidates(personal)).toEqual(personal);
  expect(personal).toEqual(["my-password", "welcome2hoc", " space "]);
});
