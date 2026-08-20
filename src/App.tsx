import { HashRouter, Route, Routes } from "react-router-dom";
import { OllamaProvider } from "./context/OllamaProvider";
import { AppShell } from "./components/AppShell";
import { Landing } from "./pages/Landing";
import { ModelsPage } from "./pages/Models";
import { ChatPage } from "./pages/Chat";
import { SettingsPage } from "./pages/Settings";
import { AgentPage } from "./pages/Agent";
import { AgentChatPage } from "./pages/AgentChat";

export default function App() {
  return (
    <OllamaProvider>
      <HashRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route element={<AppShell />}>
            <Route path="/models" element={<ModelsPage />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/agent" element={<AgentPage />} />
            <Route path="/agent/chat" element={<AgentChatPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<Landing />} />
        </Routes>
      </HashRouter>
    </OllamaProvider>
  );
}
