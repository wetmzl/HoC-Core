import { expect, test } from "@playwright/test";
import { mountDialogue } from "./dialogue-fixture";

test("主动技能成功后立即切换对白与立绘，不需要再 Hit 或 Stand", async ({ page }) => {
  await mountDialogue(page, "ability");
  await expect(page.locator("#dialogue-text")).toHaveText("旧规则对白");
  await page.locator(".skill-drawer-toggle").click();
  await page.locator('[data-skill-id="prepaid-premium"]').click();
  await expect(page.locator("#dialogue-text")).toHaveText("条件规则对白");
  await expect(page.locator(".character-portrait")).toHaveAttribute("alt", "技能回应立绘");
  await expect(page.locator('[data-skill-id="prepaid-premium"]')).toHaveCount(0);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
    await expect(page.locator("#dialogue-text")).toHaveText("条件规则对白");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("坏立绘跳过整条规则，fallback与覆盖定位在窄屏可用",async({page})=>{
  await page.route("**/missing-dialogue-art.png", route => route.fulfill({ status: 404, body: "missing" }));
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));await mountDialogue(page,"bad-art");
  await expect(page.locator("#dialogue-text")).toHaveText("条件规则对白");await expect(page.locator(".character-portrait")).toHaveAttribute("alt","中性规则立绘");await expect(page.locator(".character-portrait")).toHaveAttribute("style",/1.2/);
  for(const width of [390,320]){await page.setViewportSize({width,height:width===390?844:720});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
  expect(await page.evaluate(()=>{const {engine,match}=(window as any).__dialogueProbe;engine.select(match);engine.rejectPortrait("bad");return engine.rejectPortrait("good").line;})).toBe("角色兜底对白");expect(errors).toEqual([]);
});
test("真实API4模块注册原语，卸载后等新事件再选择且重绘不重复调用",async({page})=>{
  await mountDialogue(page,"primitive");await expect(page.locator("#dialogue-text")).toHaveText("条件规则对白");
  expect(await page.evaluate(()=>{const p=(window as any).__dialogueProbe;p.engine.select(p.match);const before=(window as any).__dialogueCalls;for(let i=0;i<100;i++)p.engine.select(p.match);return (window as any).__dialogueCalls-before;})).toBe(0);
  expect(await page.evaluate(()=>{const p=(window as any).__dialogueProbe;p.engine.select(p.match);p.plugins.release();const before=p.engine.select(p.match).line;if(before!=="条件规则对白")throw Error("Redraw replaced latched dialogue");return p.engine.select({...p.match,history:[...p.match.history,{type:"PLAYER_HIT",value:12}]}).line;})).toBe("条件规则对白");
});
test("旧图片请求失败不会覆盖行动后的新对白和立绘",async({page})=>{
  let resolveRequest!:()=>void;const gate=new Promise<void>(resolve=>resolveRequest=resolve);
  await page.route("**/dialogue-slow.png",async route=>{await gate;await route.fulfill({status:404,body:"missing"}).catch(()=>{});});
  await mountDialogue(page,"stale-art");
  await page.getByRole("button",{name:"Hit 要牌",exact:true}).click();
  await expect(page.locator("#dialogue-text")).toHaveText("旧规则对白");
  await expect(page.locator(".character-portrait")).not.toHaveAttribute("src","/characters/dialogue-slow.png");
  await page.getByRole("button",{name:"Hit 要牌",exact:true}).click();
  await expect(page.locator("#dialogue-text")).toHaveText("条件规则对白");
  const response=page.waitForResponse(r=>r.url().endsWith("dialogue-slow.png"));resolveRequest();await response;
  await expect(page.locator(".character-portrait")).toHaveAttribute("alt","新规则立绘");
  expect(await page.evaluate(()=>(window as any).__dialogueProbe.engine.diagnostics.some((d:any)=>d.ruleId==="after"))).toBe(false);
});
