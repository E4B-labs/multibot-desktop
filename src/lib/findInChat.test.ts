import { describe, expect, it } from "vitest";
import { findMatchPositions, wrapIndex } from "./findInChat";

describe("findMatchPositions", () => {
  it("zwraca offsety wszystkich trafień bez rozróżniania wielkości liter", () => {
    expect(findMatchPositions("Hello hello HELLO", "hello")).toEqual([0, 6, 12]);
    expect(findMatchPositions("banana", "n")).toEqual([2, 4]);
    expect(findMatchPositions("banana", "na")).toEqual([2, 4]);
  });

  it("nie nakłada trafień na siebie", () => {
    // "aaaa" ma dwa NIEnachodzące "aa", nie trzy
    expect(findMatchPositions("aaaa", "aa")).toEqual([0, 2]);
  });

  it("puste zapytanie i same spacje nie dają trafień", () => {
    expect(findMatchPositions("hello", "")).toEqual([]);
    expect(findMatchPositions("hello", "   ")).toEqual([]);
    expect(findMatchPositions("hello", "nope")).toEqual([]);
  });

  it("zapytanie ze znakami regexpa jest tekstem, nie wzorcem", () => {
    expect(findMatchPositions("a.c abc", "a.c")).toEqual([0]);
    expect(findMatchPositions("cost: $5 (net)", "$5 (net)")).toEqual([6]);
    expect(findMatchPositions("2+2", "+")).toEqual([1]);
  });

  it("zapytanie jest przycinane, offsety liczą się od dopasowanej treści", () => {
    expect(findMatchPositions("say hello", "  hello  ")).toEqual([4]);
  });
});

describe("wrapIndex", () => {
  it("zawija na obu końcach", () => {
    expect(wrapIndex(0, 1, 3)).toBe(1);
    expect(wrapIndex(2, 1, 3)).toBe(0);
    expect(wrapIndex(0, -1, 3)).toBe(2);
    expect(wrapIndex(1, -1, 3)).toBe(0);
  });

  it("bez trafień siedzi na zerze", () => {
    expect(wrapIndex(0, 1, 0)).toBe(0);
    expect(wrapIndex(5, -1, 0)).toBe(0);
  });

  it("radzi sobie ze skokiem większym niż liczba trafień", () => {
    expect(wrapIndex(0, 7, 3)).toBe(1);
    expect(wrapIndex(0, -7, 3)).toBe(2);
  });
});
