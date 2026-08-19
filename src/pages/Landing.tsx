import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Cpu,
  Download,
  GitBranch,
  HardDrive,
  Lock,
  MessageSquare,
  Server,
  Terminal,
} from "lucide-react";
import { Logo } from "../components/Logo";
import { Button } from "../components/ui/button";

const FEATURES = [
  {
    icon: Server,
    title: "Bring your own models",
    body: "daygle connects straight to your Ollama server — no vendor lock-in, no per-token bill.",
  },
  {
    icon: Download,
    title: "Pull & manage",
    body: "Download open models like Qwen, Llama and DeepSeek right from the workbench, with live progress.",
  },
  {
    icon: MessageSquare,
    title: "Test in chat",
    body: "Stream responses from any installed model to compare quality, speed and style before you build on it.",
  },
  {
    icon: Lock,
    title: "Private by default",
    body: "Prompts and code never leave your machine. Your models, your data, your rules.",
  },
];

const STEPS = [
  { n: "01", title: "Run Ollama", body: "Install Ollama and start the server with `ollama serve`." },
  { n: "02", title: "Point daygle at it", body: "Enter your server URL in Settings — http://localhost:11434 by default." },
  { n: "03", title: "Pull a model", body: "Grab qwen2.5-coder, llama3.2, deepseek-r1 or any model you like." },
  { n: "04", title: "Chat & build", body: "Test models in the playground and iterate toward your own agent." },
];

const FAMILIES = ["llama", "qwen", "deepseek", "mistral", "gemma", "phi", "codellama"];

export function Landing() {
  return (
    <div className="min-h-screen bg-background">
      {/* Nav */}
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3.5 md:px-8">
          <Logo />
          <div className="flex items-center gap-2">
            <a
              href="https://ollama.com/library"
              target="_blank"
              rel="noreferrer"
              className="hidden text-sm text-muted-foreground transition-colors hover:text-foreground sm:block"
            >
              Model library
            </a>
            <Link to="/models">
              <Button size="sm">
                Open the workbench
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="bg-grid absolute inset-0 [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,black,transparent)]" />
        <div className="pointer-events-none absolute -top-32 left-1/2 h-72 w-[42rem] -translate-x-1/2 rounded-full bg-accent/15 blur-3xl" />
        <div className="relative mx-auto max-w-6xl px-4 pb-20 pt-16 text-center md:px-8 md:pt-24">
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="mx-auto inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-xs font-medium text-accent"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            PRIVATE · LOCAL · FREE
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.08 }}
            className="mx-auto mt-6 max-w-3xl text-4xl font-semibold leading-tight tracking-tight md:text-6xl"
          >
            Your own AI agent, on{" "}
            <span className="text-glow text-accent">models you run</span> yourself.
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.16 }}
            className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-muted-foreground md:text-lg"
          >
            daygle is a workbench that connects to your Ollama server. Pull open-source models, test them in chat, and
            build toward an agent that writes your code — without handing your work to a cloud you don't control.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.24 }}
            className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row"
          >
            <Link to="/models">
              <Button size="lg">
                Connect your server
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
            <Link to="/settings">
              <Button size="lg" variant="outline">
                Read the setup guide
              </Button>
            </Link>
          </motion.div>

          {/* Terminal mock */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.32 }}
            className="mx-auto mt-14 max-w-2xl text-left"
          >
            <div className="glow-accent overflow-hidden rounded-xl border border-border bg-card">
              <div className="flex items-center gap-2 border-b border-border bg-muted/60 px-4 py-2.5">
                <span className="h-3 w-3 rounded-full bg-destructive/70" />
                <span className="h-3 w-3 rounded-full bg-amber-400/80" />
                <span className="h-3 w-3 rounded-full bg-accent/80" />
                <span className="ml-2 font-mono text-[11px] text-muted-foreground">daygle — terminal</span>
              </div>
              <pre className="overflow-x-auto p-5 font-mono text-xs leading-relaxed text-foreground md:text-sm">
                <span className="text-muted-foreground">$</span> <span className="text-accent">ollama pull</span> qwen2.5-coder:7b{"\n"}
                <span className="text-muted-foreground">pulling manifest…</span>{"\n"}
                <span className="text-muted-foreground">pulling a85b4d…</span> <span className="text-accent">100%</span> ██████████ <span className="text-muted-foreground">4.7 GB</span>{"\n"}
                <span className="text-muted-foreground">verifying sha256 digest…</span>{"\n"}
                <span className="text-accent">success</span> ✓{"\n"}
                {"\n"}
                <span className="text-muted-foreground">$</span> <span className="text-accent">daygle chat</span>{" "}
                <span className="text-muted-foreground">--model qwen2.5-coder:7b</span>{"\n"}
                <span className="text-muted-foreground">›</span> write a retry function with backoff{"\n"}
                <span className="text-accent">❯</span> Here's a small, typed helper…{" "}
                <span className="inline-block h-3.5 w-2 translate-y-0.5 animate-blink bg-accent" />
              </pre>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto max-w-6xl px-4 py-16 md:px-8">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <div
              key={title}
              className="rounded-xl border border-border bg-card/60 p-5 transition-colors hover:border-border/80 hover:bg-card"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <Icon className="h-5 w-5" />
              </div>
              <h3 className="mt-4 text-sm font-semibold">{title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Model families */}
      <section className="border-y border-border bg-card/40">
        <div className="mx-auto max-w-6xl px-4 py-10 md:px-8">
          <p className="text-center text-xs uppercase tracking-widest text-muted-foreground">
            Runs the models you already trust
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            {FAMILIES.map((family) => (
              <span
                key={family}
                className="rounded-full border border-border bg-background px-3.5 py-1.5 font-mono text-xs text-muted-foreground"
              >
                {family}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto max-w-6xl px-4 py-16 md:px-8">
        <div className="mb-10 text-center">
          <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">From zero to your own model in minutes</h2>
          <p className="mt-2 text-sm text-muted-foreground">No account, no cloud bill, no nonsense.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(({ n, title, body }) => (
            <div key={n} className="relative rounded-xl border border-border bg-card p-5">
              <span className="font-mono text-xs font-semibold text-accent">{n}</span>
              <h3 className="mt-3 text-sm font-semibold">{title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-4 pb-20 md:px-8">
        <div className="relative overflow-hidden rounded-2xl border border-accent/30 bg-card px-6 py-14 text-center">
          <div className="bg-grid absolute inset-0 opacity-40 [mask-image:radial-gradient(ellipse_at_center,black,transparent)]" />
          <div className="relative">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-accent-foreground">
              <Terminal className="h-6 w-6" />
            </div>
            <h2 className="mx-auto mt-5 max-w-xl text-2xl font-semibold tracking-tight md:text-3xl">
              Stop renting someone else's brain.
            </h2>
            <p className="mx-auto mt-3 max-w-md text-sm text-muted-foreground">
              Connect daygle to Ollama and start building on models you actually own.
            </p>
            <Link to="/models" className="mt-7 inline-block">
              <Button size="lg">
                Open the workbench
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-xs text-muted-foreground md:flex-row md:px-8">
          <Logo />
          <div className="flex items-center gap-5">
            <span className="flex items-center gap-1.5">
              <Cpu className="h-3.5 w-3.5" /> local-first
            </span>
            <span className="flex items-center gap-1.5">
              <GitBranch className="h-3.5 w-3.5" /> open models
            </span>
            <span className="flex items-center gap-1.5">
              <HardDrive className="h-3.5 w-3.5" /> your hardware
            </span>
          </div>
          <span>daygle — your private AI workbench</span>
        </div>
      </footer>
    </div>
  );
}
