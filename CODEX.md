# CafeBot Project Guide

## Project purpose

CafeBot is a beginner-friendly project for a cafe chatbot. The repository currently contains a starter structure and notes only. Build features only when a task explicitly asks for them, and keep the project simple and low-cost.

## Simple architecture

The planned parts are:

- `frontend/` — the customer-facing interface.
- `backend/` — server-side request handling and chatbot logic.
- `prompts/` — chatbot instructions and prompt drafts.
- `data/` — non-sensitive sample or development data.
- `env/` — examples of local configuration; real secrets belong in an ignored `.env` file.

A future request may connect the frontend to the backend, which can use prompts and data to prepare a response. Add an external AI provider or other service only when requested and necessary; account for its cost.

## Coding rules

- Prefer clear, beginner-friendly names and small, focused changes.
- Follow the language and style already present in the files you need to edit. If no implementation exists yet, choose the simplest suitable approach for the requested task.
- Avoid adding dependencies, frameworks, infrastructure, or abstractions without a concrete need.
- Keep documentation accurate when a requested change affects it.
- Do not build unrequested features or the application as a whole.

## Security rules

- Never put API keys, passwords, tokens, or other secrets in source code, prompts, sample data, or committed files.
- Use environment variables for local secrets. Keep `.env` files private and preserve the repository's ignore rules.
- Use fictional or non-sensitive sample data; do not add real customer or payment information.
- Validate and limit untrusted user input before using it in backend operations or passing it to external services.
- Avoid logging secrets, credentials, or private customer information.

## Token-saving rules

- Read only the files needed to understand and complete the current task.
- Make a focused change; avoid unrelated rewrites and repeated explanations.
- Keep generated code, prompts, comments, and documentation concise while remaining clear.
- Avoid unnecessary dependencies, verbose output, duplicated context, and speculative implementation.
- Summarize the result briefly and mention relevant checks only when they were requested or useful to report.

## Scope of changes

For each task, modify only the files needed to complete that task. Do not make opportunistic cleanup or formatting changes elsewhere. If a task does not require changing a file, leave it untouched. Before editing, inspect the relevant files; after editing, review the changed files for accidental scope expansion.
