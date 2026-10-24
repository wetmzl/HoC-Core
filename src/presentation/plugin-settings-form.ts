import type { PluginSettingsSession } from "../content/packages/plugin-settings";
import type { PluginSettingField, PluginSettingValue } from "../content/packages/plugin-declarations";

/** Host-owned form: all plugin text is inserted as text, never HTML. */
export function mountPluginSettingsForm(container: HTMLElement, session: PluginSettingsSession, commit: (packageId: string, values: Record<string, PluginSettingValue>) => Promise<void>): void {
  container.replaceChildren();
  const entries = session.list().filter(entry => entry.declaration.fields.some(field => !field.hidden));
  if (!entries.length) return;
  const heading = document.createElement("h3"); heading.textContent = "插件设置"; container.append(heading);
  for (const entry of entries) {
    const section = document.createElement("details"); section.className = "plugin-settings-section"; section.dataset.pluginSettings = entry.packageId;
    const summary = document.createElement("summary"); summary.className = "plugin-settings-summary"; summary.textContent = entry.title;
    const body = document.createElement("div"); body.className = "plugin-settings-body";
    section.append(summary, body);
    const status = document.createElement("p"); status.className = "status-line"; status.setAttribute("role", "status"); status.textContent = session.notices(entry.packageId).join(" ");
    let controls: Array<{ field: PluginSettingField; input: HTMLInputElement | HTMLSelectElement }> = [];
    const populate = () => {
      controls = [];
      body.querySelectorAll(".plugin-setting-group,.plugin-setting-field").forEach(node => node.remove());
      const fields = entry.declaration.fields.filter(field => !field.hidden).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const groups = new Map<string, HTMLElement>();
      for (const field of fields) {
        const label = document.createElement("label"); label.className = "plugin-setting-field";
        const name = document.createElement("span"); name.textContent = field.label; label.append(name);
        const input = field.schema.enum ? document.createElement("select") : document.createElement("input");
        input.dataset.pluginSetting = field.id;
        if (input instanceof HTMLSelectElement) for (const value of field.schema.enum as PluginSettingValue[]) {
          const option = document.createElement("option"); option.value = JSON.stringify(value); option.textContent = String(value); input.append(option);
        } else {
          input.type = field.schema.type === "boolean" ? "checkbox" : ["number", "integer"].includes(String(field.schema.type)) ? "number" : "text";
          if (input.type === "number") {
            input.step = String(field.schema.multipleOf ?? (field.schema.type === "integer" ? 1 : "any"));
            if (field.schema.minimum !== undefined) input.min = String(field.schema.minimum);
            if (field.schema.maximum !== undefined) input.max = String(field.schema.maximum);
          }
          if (input.type === "text" && field.schema.maxLength !== undefined) input.maxLength = Number(field.schema.maxLength);
        }
        const value = session.values(entry.packageId)[field.id];
        if (input instanceof HTMLInputElement && input.type === "checkbox") input.checked = value === true;
        else input.value = input instanceof HTMLSelectElement ? JSON.stringify(value) : String(value);
        label.append(input);
        const help = document.createElement("small"); help.textContent = `${field.description}${field.apply === "restart" ? "（下次启动游戏生效）" : ""}`; label.append(help);
        if (field.group) {
          let group = groups.get(field.group);
          if (!group) { group = document.createElement("div"); group.className = "plugin-setting-group"; const title = document.createElement("h4"); title.textContent = field.group; group.append(title); groups.set(field.group, group); body.insertBefore(group, status); }
          group.append(label);
        } else body.insertBefore(label, status);
        controls.push({ field, input });
      }
    };
    body.append(status); populate();
    const actions = document.createElement("div"); actions.className = "save-actions";
    const save = document.createElement("button"); save.type = "button"; save.className = "secondary-button"; save.textContent = "保存插件设置";
    const reset = document.createElement("button"); reset.type = "button"; reset.className = "secondary-button"; reset.textContent = "恢复本插件默认值";
    const submit = async (defaults: boolean) => {
      const dialog = container.closest("dialog");
      const disabled = new Map([...dialog?.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input,button,select") ?? []].map(node => [node, node.disabled]));
      disabled.forEach((_, node) => { node.disabled = true; });
      try {
        const values = Object.fromEntries(controls.map(({ field, input }) => [field.id, defaults ? field.default : input instanceof HTMLSelectElement ? JSON.parse(input.value) : input.type === "checkbox" ? input.checked : input.type === "number" ? input.value.trim() ? Number(input.value) : NaN : input.value]));
        await commit(entry.packageId, { ...session.values(entry.packageId), ...values });
        status.textContent = "插件设置已保存。" + (entry.declaration.fields.some(f => f.apply === "restart") ? "部分设置下次启动游戏生效。" : "");
        populate();
      } catch (error) { status.textContent = error instanceof Error ? error.message : "插件设置保存失败，请重试。"; }
      finally { disabled.forEach((value, node) => { node.disabled = value; }); }
    };
    save.addEventListener("click", () => { void submit(false); }); reset.addEventListener("click", () => { void submit(true); });
    actions.append(save, reset); body.append(actions); container.append(section);
  }
}
