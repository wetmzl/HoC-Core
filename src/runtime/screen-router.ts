import type {
  MountedScreen,
  RuntimeNavigation,
  RuntimeScreenContext,
  RuntimeScreenId,
  RuntimeScreenLoader,
  RuntimeScreenModule
} from "./contracts";

export class RuntimeScreenRouter {
  private readonly modules = new Map<RuntimeScreenId, RuntimeScreenModule>();
  private readonly pendingModules = new Map<RuntimeScreenId, Promise<RuntimeScreenModule>>();
  private current?: { readonly mounted: MountedScreen; readonly controller: AbortController };
  private navigationToken = 0;
  private disposed = false;

  constructor(
    private readonly context: RuntimeScreenContext,
    private readonly loaders: Readonly<Partial<Record<RuntimeScreenId, RuntimeScreenLoader>>>
  ) {}

  async navigate(destination: RuntimeNavigation): Promise<void> {
    if (this.disposed) return;
    const token = ++this.navigationToken;
    const loader = this.loaders[destination.id];
    if (!loader) {
      this.context.reportNavigationError("该页面当前不可用。");
      return;
    }

    let module: RuntimeScreenModule;
    try {
      module = await this.loadModule(destination.id, loader);
    } catch {
      if (token === this.navigationToken && !this.disposed) this.context.reportNavigationError("页面加载失败，请重试。");
      return;
    }
    if (token !== this.navigationToken || this.disposed) return;

    const previous = this.current;
    this.current = undefined;
    previous?.controller.abort();
    await previous?.mounted.dispose();
    if (token !== this.navigationToken || this.disposed) return;

    const controller = new AbortController();
    let mounted: MountedScreen;
    try {
      mounted = await module.mount(this.context, controller.signal, destination.params);
    } catch {
      controller.abort();
      if (token === this.navigationToken && !this.disposed) this.context.reportNavigationError("页面打开失败，请重试。");
      return;
    }
    if (token !== this.navigationToken || this.disposed) {
      controller.abort();
      await mounted.dispose();
      return;
    }
    this.current = { mounted, controller };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.navigationToken += 1;
    const current = this.current;
    this.current = undefined;
    current?.controller.abort();
    await current?.mounted.dispose();
    this.pendingModules.clear();
    this.modules.clear();
  }

  private loadModule(id: RuntimeScreenId, loader: RuntimeScreenLoader): Promise<RuntimeScreenModule> {
    const loaded = this.modules.get(id);
    if (loaded) return Promise.resolve(loaded);
    const pending = this.pendingModules.get(id);
    if (pending) return pending;
    const request = loader().then((module) => {
      this.modules.set(id, module);
      return module;
    }).finally(() => this.pendingModules.delete(id));
    this.pendingModules.set(id, request);
    return request;
  }
}
