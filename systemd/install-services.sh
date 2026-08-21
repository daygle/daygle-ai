#!/bin/bash
# Install daygle systemd services
# Run as root: sudo bash systemd/install-services.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing daygle systemd services..."

cp "$SCRIPT_DIR/daygle-ai-ollama.service" /etc/systemd/system/
cp "$SCRIPT_DIR/daygle-ai-ui.service" /etc/systemd/system/
cp "$SCRIPT_DIR/daygle-ai-agent.service" /etc/systemd/system/

systemctl daemon-reload

systemctl enable daygle-ai-ollama.service
systemctl enable daygle-ai-ui.service
systemctl enable daygle-ai-agent.service

echo ""
echo "Starting services..."
systemctl start daygle-ai-ollama.service
systemctl start daygle-ai-ui.service
systemctl start daygle-ai-agent.service

echo ""
echo "✅ All services installed and started!"
echo ""
echo "Check status:"
echo "  systemctl status daygle-ai-ollama"
echo "  systemctl status daygle-ai-ui"
echo "  systemctl status daygle-ai-agent"
echo ""
echo "View logs:"
echo "  journalctl -u daygle-ai-ollama -f"
echo "  journalctl -u daygle-ai-ui -f"
echo "  journalctl -u daygle-ai-agent -f"
