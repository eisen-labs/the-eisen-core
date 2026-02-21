// biome-ignore lint/correctness/noUnusedImports: JSX runtime
import { h } from "../jsx-runtime";
import { AppStore, type RecentWorkspace } from "../../store";
import { open } from "@tauri-apps/plugin-dialog";

export interface WelcomeCb {
  onOpen(path: string): void;
}

export class Welcome {
  el: HTMLElement;
  private recentList: HTMLElement;
  private cb: WelcomeCb;
  private recentWorkspaces: RecentWorkspace[] = [];

  constructor(cb: WelcomeCb) {
    this.cb = cb;
    this.recentList = (<div className="flex flex-col gap-0.5" />) as HTMLElement;

    this.el = (
      <div className="flex flex-col items-center justify-center w-full h-full min-h-full bg-bg text-foreground animate-in fade-in duration-500">
        <div className="max-w-2xl w-full flex flex-col gap-12 p-12">
          {/* Block 1: App name */}
          <div className="flex flex-col gap-6 flex-shrink-0">
            <div className="flex items-center gap-5">
              <div className="w-14 h-14 rounded-2xl bg-accent flex items-center justify-center shadow-2xl shadow-accent/30 ring-1 ring-white/20">
                <svg width="36" height="36" viewBox="0 0 96 96" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="48" cy="48" r="29" stroke="white" stroke-width="6"/>
                  <circle cx="48" cy="48" r="43" stroke="white" stroke-width="10"/>
                </svg>
              </div>
              <div className="flex flex-col">
                <h1 className="text-4xl font-bold tracking-tight text-white">Eisen</h1>
                <p className="text-muted text-md">Accelerate your engineering with autonomous agents.</p>
              </div>
            </div>
          </div>

          {/* Block 2: Functions – Open project, Clone repo */}
          <div className="flex flex-col gap-4 flex-shrink-0">
            <h2 className="text-faint text-[10px] font-bold uppercase tracking-[0.2em]">Start</h2>
            <div className="grid grid-cols-2 gap-3">
              <button 
                type="button"
                className="flex items-center gap-4 p-4 rounded-xl bg-surface hover:bg-raised border border-border-subtle transition-all duration-200 text-left group"
                onClick={() => this.handleOpenFolder()}
              >
                <div className="w-10 h-10 rounded-lg bg-accent/10 text-accent flex items-center justify-center group-hover:bg-accent group-hover:text-white transition-colors">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                </div>
                <div className="flex flex-col">
                  <span className="font-semibold text-sm">Open Folder</span>
                  <span className="text-[11px] text-faint group-hover:text-muted">Explore a local project</span>
                </div>
              </button>

              <button 
                type="button"
                className="flex items-center gap-4 p-4 rounded-xl bg-surface hover:bg-raised border border-border-subtle transition-all duration-200 text-left group opacity-50 cursor-not-allowed"
              >
                <div className="w-10 h-10 rounded-lg bg-white/5 text-muted flex items-center justify-center">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </div>
                <div className="flex flex-col">
                  <span className="font-semibold text-sm">Clone Repository</span>
                  <span className="text-[11px] text-faint">Coming soon</span>
                </div>
              </button>
            </div>
            <div className="flex items-center gap-6 text-xs text-muted">
              <a href="#" className="hover:text-accent transition-colors">Documentation</a>
              <a href="#" className="hover:text-accent transition-colors">Release Notes</a>
              <a href="#" className="hover:text-accent transition-colors">GitHub</a>
            </div>
          </div>

          {/* Block 3: Recent projects (bottom) – max 5 items, compact height */}
          <div className="flex flex-col flex-shrink-0 max-h-[300px] overflow-hidden">
            <div className="p-4 border-b border-border-subtle flex-shrink-0">
              <h2 className="text-faint text-[10px] font-bold uppercase tracking-[0.2em]">Recent projects</h2>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {this.recentList}
            </div>
          </div>
        </div>
      </div>
    ) as HTMLElement;

    this.loadRecent();
  }

  private async loadRecent() {
    this.recentWorkspaces = await AppStore.getInstance().getRecentWorkspaces();
    this.renderRecentList();
  }

  private renderRecentList() {
    this.recentList.innerHTML = "";
    const recent = this.recentWorkspaces.slice(0, 5);

    if (recent.length === 0) {
      this.recentList.append((
        <div className="flex flex-col items-center justify-center py-8 px-6 text-center gap-3">
          <div className="text-faint italic text-sm">No recent workspaces</div>
        </div>
      ) as HTMLElement);
      return;
    }

    for (const w of recent) {
      const item = (
        <div className="relative group">
          <button 
            type="button"
            className="w-full flex flex-col gap-0.5 px-4 py-3 rounded-xl hover:bg-white/5 transition-all text-left border border-transparent hover:border-border-subtle pr-12"
            onClick={() => this.cb.onOpen(w.path)}
          >
            <div className="font-semibold text-sm text-foreground group-hover:text-accent transition-colors truncate">{w.name}</div>
            <div className="text-[10px] text-faint truncate font-mono opacity-70 group-hover:opacity-100">{w.path}</div>
          </button>
          <button 
            type="button"
            className="absolute right-3 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-500/10 hover:text-red-500 text-faint opacity-0 group-hover:opacity-100 transition-all border border-transparent hover:border-red-500/20"
            title="Remove from recent"
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              this.handleRemoveRecent(w.path);
            }}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ) as HTMLElement;
      
      this.recentList.append(item);
    }
  }

  private async handleRemoveRecent(path: string) {
    await AppStore.getInstance().removeRecentWorkspace(path);
    this.recentWorkspaces = this.recentWorkspaces.filter(w => w.path !== path);
    this.renderRecentList();
  }

  private async handleOpenFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      this.cb.onOpen(selected);
    }
  }
}
