import { describe, expect, it } from "vitest";
import { createCard, createDerivedCard } from "../blackjack/card";
import { createHand } from "../blackjack/hand";
import { drawPhysicalCardForLimit } from "./card-zone-adapter";
import { evaluateCondition } from "./conditions";
import type { Rank } from "../blackjack/types";
import type { AbilityInstance, AbilityWorld } from "./types";

const cards = (ranks: Rank[]) => ranks.map((rank,i)=>createCard("clubs",rank,"card-"+i));
describe("physical card selection policies",()=>{
 it("prefers an exact limit over a smaller available card",()=>{
  const shoe={cards:cards(["A","2","8"]),cursor:0,shuffleIndex:0};
  const result=drawPhysicalCardForLimit(shoe,createHand(cards(["10","3"])),21)!;
  expect(result.card.attributes.rank).toBe("8");expect(result.shoe.cursor).toBe(1);
  expect(new Set(result.shoe.cards.map(c=>c.id))).toEqual(new Set(shoe.cards.map(c=>c.id)));
  expect(shoe.cursor).toBe(0);expect(shoe.cards[0].attributes.rank).toBe("A");
 });
 it("falls back to the lowest card rather than the highest safe resulting total",()=>{
  expect(drawPhysicalCardForLimit({cards:cards(["2","7","K"]),cursor:0,shuffleIndex:0},createHand(cards(["5","3"])),21)!.card.attributes.rank).toBe("2");
 });
 it("treats A as the lowest fallback and never repairs an already busted hand",()=>{
  const result=drawPhysicalCardForLimit({cards:cards(["A","2","K"]),cursor:0,shuffleIndex:0},createHand(cards(["K","Q","5"])),21)!;
  expect(result.card.attributes.rank).toBe("A");expect(result.card.attributes.source).toBe("shoe");
 });
 it("honors a modified limit and ignores already consumed cards",()=>{
  const result=drawPhysicalCardForLimit({cards:cards(["8","A","4","7"]),cursor:1,shuffleIndex:0},createHand(cards(["10","3"])),20)!;
  expect(result.card.attributes.rank).toBe("7");expect(result.shoe.cursor).toBe(2);
 });
 it("fails without consuming anything on an empty shoe",()=>{
  expect(drawPhysicalCardForLimit({cards:[],cursor:0,shuffleIndex:0},createHand(),21)).toBeUndefined();
 });
});
describe("acquired card source facts",()=>{
 const ability={owner:"player"} as AbilityInstance;
 const world={} as AbilityWorld;
 it("reads the acquired event card rather than a subsequently appended hand card",()=>{
  const ctx={ability,world,event:{trigger:"after-card-acquired" as const,sourceEventId:"one",acquiredCards:[createCard("clubs","3","physical")]}};
  expect(evaluateCondition({type:"acquired-card-source-is",source:"shoe"},ctx)).toBe(true);
  expect(evaluateCondition({type:"acquired-card-source-is",source:"derived"},{...ctx,event:{...ctx.event,acquiredCards:[createDerivedCard("clubs","A","derived")]}})).toBe(true);
  expect(evaluateCondition({type:"acquired-card-source-is",source:"shoe"},{...ctx,event:{...ctx.event,acquiredCards:[]}})).toBe(false);
 });
 it("reads a round bust fact without recomputing or repairing hands",()=>{
  expect(evaluateCondition({type:"round-had-bust"},{ability,world,event:{trigger:"before-trigger-pull",sourceEventId:"fact",roundHadBust:true}})).toBe(true);
 });
});

