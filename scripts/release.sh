#!/bin/sh
set -e

# Release a new version: tag, push, optional GitHub release.
# Usage: bun run release <version>
# Example: bun run release 1.0.6

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "Usage: bun run release <version>"
  echo "Example: bun run release 1.0.6"
  exit 1
fi

# Ensure working directory is clean
if [ -n "$(git status --porcelain)" ]; then
  echo "Error: working directory is not clean. Commit or stash changes first."
  exit 1
fi

# Ensure we're on the right branch
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
  echo "Warning: you are on '$BRANCH', not 'main'. Continue? (y/N)"
  read -r REPLY
  if [ "$REPLY" != "y" ] && [ "$REPLY" != "Y" ]; then
    exit 1
  fi
fi

TAG="v${VERSION}"

echo "=== Tagging ${TAG} ==="
git tag "$TAG"

echo "=== Pushing tag ==="
git push origin "$TAG"

echo ""
echo "Done! Tag ${TAG} pushed to origin."
echo "GitHub will create a release automatically from the tag."
echo ""
echo "Update check will now show version ${VERSION} as current."