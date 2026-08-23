import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { OllamaProvider } from "./context/OllamaProvider";
import { ThemeProvider } from "./context/ThemeProvider";
import { AppShell } from "./components/AppShell";
import { Landing } from "./pages/Landing";
import { ModelsPage } from "./pages/Models";
import { SettingsPage } from "./pages/Settings";
import { AgentPage } from "./pages/Agent";

export default function App() {
  return (
    <ThemeProvider>
      <OllamaProvider>
        <HashRouter>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route element={<AppShell />}>
              <Route path="/models" element={<ModelsPage />} />
              <Route path="/agent" element={<AgentPage />} />
              {/* Chat and Agent Chat were merged into the unified Agent page. */}
              <Route path="/chat" element={<Navigate to="/agent" replace />} />
              <Route path="/agent/chat" element={<Navigate to="/agent" replace />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
            <Route path="*" element={<Landing />} />
          </Routes>
        </HashRouter>
      </OllamaProvider>
    </ThemeProvider>
  );
}
