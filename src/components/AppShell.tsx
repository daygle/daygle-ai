import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Bot, Box, Settings } from "lucide-react";
import { Logo } from "./Logo";
import { ConnectionStatus } from "./ConnectionStatus";
import { cn } from "../lib/utils";

const nav = [
  { to: "/models", label: "Models", icon: Box },
  { to: "/agent", label: "Agent", icon: Bot },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const isAgentRoute = location.pathname === "/agent";

  return (
    <div className="min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-border bg-card/50 md:flex">
        <button onClick={() => navigate("/")} className="flex items-center px-5 py-5 text-left">
          <Logo />
        </button>
        <nav className="flex flex-col gap-1 px-3">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto p-3">
          <ConnectionStatus />
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-border bg-background/85 px-4 py-3 backdrop-blur md:hidden">
        <button onClick={() => navigate("/")} className="text-left">
          <Logo />
        </button>
        <nav className="flex gap-1">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs font-medium transition-colors",
                  isActive ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
                )
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="md:pl-60">
        <div className={isAgentRoute ? "p-0" : "mx-auto max-w-6xl p-4 md:p-8"}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}
