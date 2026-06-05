# AGENTS.md

## Project

This repo contains a local WhatsApp group monitor built with TypeScript and
Baileys, plus Python digest sidecar scripts under `scripts/digest/`.

## Commands

- Install Node dependencies: `npm install`
- Run the monitor in development: `npm run dev`
- Build TypeScript: `npm run build`
- Run built service: `npm start`
- Sync Python dependencies: `npm run py:sync`
- Preview digest without sending Telegram messages: `npm run digest:preview`
- Run the digest pipeline: `npm run digest`

## Local Data

Do not commit runtime or personal data. The `data/` directory is local state and
can contain WhatsApp auth keys, group IDs, phone numbers, captured messages,
digest databases, logs, and model state.

Local configuration belongs in `.env` and `data/config.json`. Keep shareable
examples in `.env.example` or `*.sample.*` / `*.example.*` files.

## Git Hygiene

- Keep `node_modules/`, `.venv/`, `dist/`, `.env*`, and `data/` out of Git.
- Commit source files, lockfiles, docs, and configuration examples.
- Before committing, check `git status --short --ignored` and make sure ignored
  local data is not staged.
