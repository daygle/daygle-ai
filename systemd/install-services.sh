#!/bin/bash
# Install daygle systemd services
# Run as root: sudo bash systemd/install-services.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing daygle systemd services..."

cp "$SCRIPT_DIR/daygle-ollama.service" /etc/systemd/system/
cp "$SCRIPT_DIR/daygle-ui.service" /etc/systemd/system/
cp "$SCRIPT_DIR/daygle-agent.service" /etc/systemd/system/

systemctl daemon-reload

systemctl enable daygle-ollama.service
systemctl enable daygle-ui.service
systemctl enable daygle-agent.service

echo ""
echo "Starting services..."
systemctl start daygle-ollama.service
systemctl start daygle-ui.service
systemctl start daygle-agent.service

echo ""
echo "✅ All services installed and started!"
echo ""
echo "Check status:"
echo "  systemctl status daygle-ollama"
echo "  systemctl status daygle-ui"
echo "  systemctl status daygle-agent"
echo ""
echo "View logs:"
echo "  journalctl -u daygle-ollama -f"
echo "  journalctl -u daygle-ui -f"
echo "  journalctl -u daygle-agent -f"
