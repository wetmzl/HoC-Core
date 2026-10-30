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
    let saving = false;
    const populate = () => {
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
            // A range needs explicit bounds and a step grid compatible with the schema.
            const min = Number(input.min), max = Number(input.max), step = Number(input.step);
            if (input.min && input.max && min < max
              && field.schema.exclusiveMinimum === undefined && field.schema.exclusiveMaximum === undefined
              && (input.step === "any" || Math.abs(min / step - Math.round(min / step)) < 1e-8)
              && (field.schema.type !== "integer" || Number.isInteger(min) && Number.isInteger(step))) input.type = "range";
          }
          if (input.type === "text" && field.schema.maxLength !== undefined) input.maxLength = Number(field.schema.maxLength);
        }
        const value = session.values(entry.packageId)[field.id];
        if (input instanceof HTMLInputElement && input.type === "checkbox") input.checked = value === true;
        else input.value = input instanceof HTMLSelectElement ? JSON.stringify(value) : String(value);
        label.append(input);
        let updateReadout: (() => void) | undefined;
        if (input instanceof HTMLInputElement && input.type === "range") {
          input.setAttribute("aria-label", field.label);
          const readout = document.createElement("span"); readout.className = "plugin-setting-value"; readout.setAttribute("aria-hidden", "true");
          updateReadout = () => { readout.textContent = input.value; };
          input.addEventListener("input", updateReadout); updateReadout();
          name.className = "plugin-setting-heading"; name.append(readout);
        }
        input.addEventListener("change", () => { void submit({ field, input, updateReadout }); });
        const help = document.createElement("small"); help.textContent = `${field.description}${input instanceof HTMLInputElement && input.type === "range" ? " 松开自动保存。" : ""}${field.apply === "restart" ? "（下次启动游戏生效）" : ""}`; label.append(help);
        if (field.group) {
          let group = groups.get(field.group);
          if (!group) { group = document.createElement("div"); group.className = "plugin-setting-group"; const title = document.createElement("h4"); title.textContent = field.group; group.append(title); groups.set(field.group, group); body.insertBefore(group, status); }
          group.append(label);
        } else body.insertBefore(label, status);
      }
    };
    body.append(status); populate();
    const actions = document.createElement("div"); actions.className = "save-actions";
    const reset = document.createElement("button"); reset.type = "button"; reset.className = "secondary-button"; reset.textContent = "恢复本插件默认值";
    const submit = async (changed?: { field: PluginSettingField; input: HTMLInputElement | HTMLSelectElement; updateReadout?: () => void }) => {
      if (saving) return;
      saving = true;
      const restoreFocus = changed && document.activeElement === changed.input;
      const scope = container.closest("dialog") ?? container;
      const disabled = new Map([...scope.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input,button,select")].map(node => [node, node.disabled]));
      disabled.forEach((_, node) => { node.disabled = true; });
      status.textContent = "正在保存插件设置…";
      try {
        const values = changed
          ? { [changed.field.id]: changed.input instanceof HTMLSelectElement ? JSON.parse(changed.input.value) : changed.input.type === "checkbox" ? changed.input.checked : changed.input.type === "number" || changed.input.type === "range" ? changed.input.value.trim() ? Number(changed.input.value) : NaN : changed.input.value }
          : { ...session.values(entry.packageId), ...Object.fromEntries(entry.declaration.fields.filter(field => !field.hidden).map(field => [field.id, field.default])) };
        await commit(entry.packageId, values);
        status.textContent = "插件设置已保存。" + ((changed ? changed.field.apply === "restart" : entry.declaration.fields.some(f => f.apply === "restart")) ? "部分设置下次启动游戏生效。" : "");
        if (!changed) populate();
      } catch (error) {
        if (changed) {
          const value = session.values(entry.packageId)[changed.field.id];
          if (changed.input instanceof HTMLInputElement && changed.input.type === "checkbox") changed.input.checked = value === true;
          else changed.input.value = changed.input instanceof HTMLSelectElement ? JSON.stringify(value) : String(value);
          changed.updateReadout?.();
        }
        status.textContent = error instanceof Error ? error.message : "插件设置保存失败，请重试。";
      } finally {
        disabled.forEach((value, node) => { node.disabled = value; });
        saving = false;
        if (restoreFocus && changed && section.open && document.activeElement === document.body) changed.input.focus({ preventScroll: true });
      }
    };
    reset.addEventListener("click", () => { void submit(); });
    actions.append(reset); body.append(actions); container.append(section);
  }
}
