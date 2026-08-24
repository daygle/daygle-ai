import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { OllamaProvider } from "./context/OllamaProvider";
import { CloudProviderProvider } from "./context/CloudProviderContext";
import { ThemeProvider } from "./context/ThemeProvider";
import { AppShell } from "./components/AppShell";
import { Landing } from "./pages/Landing";
import { ModelsPage } from "./pages/Models";
import { SettingsPage } from "./pages/Settings";
import { AgentPage } from "./pages/Agent";
import { ChatPage } from "./pages/Chat";

export default function App() {
  return (
    <ThemeProvider>
      <CloudProviderProvider>
        <OllamaProvider>
          <HashRouter>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route element={<AppShell />}>
              <Route path="/models" element={<ModelsPage />} />
              <Route path="/agent" element={<AgentPage />} />
              <Route path="/chat" element={<ChatPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
            <Route path="*" element={<Landing />} />
          </Routes>
          </HashRouter>
        </OllamaProvider>
      </CloudProviderProvider>
    </ThemeProvider>
  );
}
