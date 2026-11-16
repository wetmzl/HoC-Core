import type {
  MountedScreen,
  RuntimeNavigation,
  RuntimeScreenContext,
  RuntimeScreenId,
  RuntimeScreenLoader,
  RuntimeScreenModule
} from "./contracts";

export interface RuntimeScreenChange {
  readonly from?: string;
  readonly to?: string;
}

export class RuntimeScreenRouter {
  private readonly modules = new Map<RuntimeScreenId, RuntimeScreenModule>();
  private readonly pendingModules = new Map<RuntimeScreenId, Promise<RuntimeScreenModule>>();
  private current?: { readonly mounted: MountedScreen; readonly controller: AbortController; readonly id: string };
  private navigationToken = 0;
  private mountingController?: AbortController;
  private disposed = false;

  constructor(
    private readonly context: RuntimeScreenContext,
    private readonly loaders: Readonly<Partial<Record<RuntimeScreenId, RuntimeScreenLoader>>>,
    private readonly changed?: (change: RuntimeScreenChange) => void
  ) {}

  get screenId(): string | undefined { return this.current?.id; }

  private notify(change: RuntimeScreenChange): void {
    try { this.changed?.(change); }
    catch (error) { console.warn("页面生命周期观察者失败", error); }
  }

  async navigate(destination: RuntimeNavigation): Promise<void> {
    if (this.disposed) return;
    this.mountingController?.abort();
    const token = ++this.navigationToken;
    const loader = this.loaders[destination.id];
    if (!loader) {
      this.context.reportNavigationError("该页面当前不可用。");
      return;
    }

    await this.mountLoaded(loader, destination.params, token, destination.id);
  }

  /** Adapts internal and contributed pages without changing public plugin routes. */
  async navigateModule(loader: RuntimeScreenLoader, params?: Readonly<Record<string, unknown>>, screenId = "custom"): Promise<void> {
    if (this.disposed) return;
    this.mountingController?.abort();
    await this.mountLoaded(loader, params, ++this.navigationToken, undefined, screenId);
  }

  private async mountLoaded(loader: RuntimeScreenLoader, params: Readonly<Record<string, unknown>> | undefined, token: number, id?: RuntimeScreenId, screenId = id ?? "custom"): Promise<void> {
    let module: RuntimeScreenModule;
    try {
      module = await (id ? this.loadModule(id, loader) : loader());
    } catch {
      if (token === this.navigationToken && !this.disposed) this.context.reportNavigationError("页面加载失败，请重试。");
      return;
    }
    if (token !== this.navigationToken || this.disposed) return;

    const previous = this.current;
    this.current = undefined;
    previous?.controller.abort();
    await previous?.mounted.dispose();
    if (previous) this.notify({ from: previous.id });
    if (token !== this.navigationToken || this.disposed) return;

    const controller = new AbortController();
    this.mountingController = controller;
    let mounted: MountedScreen;
    try {
      mounted = await module.mount(this.context, controller.signal, params);
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
    this.mountingController = undefined;
    this.current = { mounted, controller, id: screenId };
    this.notify({ to: screenId });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.mountingController?.abort();
    this.mountingController = undefined;
    this.navigationToken += 1;
    const current = this.current;
    this.current = undefined;
    current?.controller.abort();
    await current?.mounted.dispose();
    if (current) this.notify({ from: current.id });
    this.pendingModules.clear();
    this.modules.clear();
  }

  private loadModule(id: RuntimeScreenId, loader: RuntimeScreenLoader): Promise<RuntimeScreenModule> {
    const loaded = this.modules.get(id);
    if (loaded) return Promise.resolve(loaded);
    const pending = this.pendingModules.get(id);
    if (pending) return pending;
    const request = loader().then((module) => {
      if (!this.disposed) this.modules.set(id, module);
      return module;
    }).finally(() => { if (this.pendingModules.get(id) === request) this.pendingModules.delete(id); });
    this.pendingModules.set(id, request);
    return request;
  }
}
