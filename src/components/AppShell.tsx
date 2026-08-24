import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Bot, Box, MessageCircle, Moon, Settings, Sun } from "lucide-react";
import { Logo } from "./Logo";
import { ConnectionStatus } from "./ConnectionStatus";
import { cn } from "../lib/utils";
import { useTheme } from "../context/ThemeProvider";

const nav = [
  { to: "/agent", label: "Agent", icon: Bot },
  { to: "/chat", label: "Chat", icon: MessageCircle },
  { to: "/models", label: "Models", icon: Box },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const isFullHeightRoute = location.pathname === "/agent" || location.pathname === "/chat";
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="flex h-[100dvh] flex-col bg-background">
      {/* Top nav bar - holds the logo, menu items, and connection status so the
          left edge is free for a single page-level sidebar (e.g. chat history). */}
      <header className="sticky top-0 z-40 flex shrink-0 items-center gap-3 border-b border-border bg-card/50 px-4 py-2.5 backdrop-blur sm:gap-6">
        <button onClick={() => navigate("/")} className="shrink-0 text-left">
          <Logo />
        </button>
        <nav className="flex items-center gap-1">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )
              }
            >
              <Icon className="h-4 w-4" />
              <span className="hidden sm:inline">{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={toggleTheme}
            className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <ConnectionStatus compact />
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden">
        {isFullHeightRoute ? (
          <div className="h-full">
            <Outlet />
          </div>
        ) : (
          <div className="h-full overflow-y-auto">
            <div className="mx-auto max-w-6xl p-4 md:p-8">
              <Outlet />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
