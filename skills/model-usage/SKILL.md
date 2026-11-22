---
name: model-usage
description: Surface the real-time Model Usage side-pane UI pill (`sidecar://model-usage/usage_monitor/`) or summarize current model quotas, reset timers, and conversation token usage. Use whenever the user asks about model usage, token counts, remaining quota, rate limits, or opening the Model Usage monitor.
---

# Model Usage UI & Diagnostics Skill

The **Model Usage** plugin includes a live side-pane UI panel (`model-usage/usage_monitor`) that refreshes every 5 seconds with zero LLM token consumption.

## 1. Opening the Real-Time Side-Pane Monitor

Whenever the user asks to view, open, or monitor their model usage, quota remaining, or token consumption in real time, surface a one-click pill in chat using the `sidecar://` link scheme:

```markdown
[Model Usage](sidecar://model-usage/usage_monitor/)
```

Remind the user that they can also open **Model Usage** anytime from the conversation's auxiliary (side) pane `+` menu, and toggle between **Full** and **Minimal** modes inside the panel header.

## 2. Managing or Toggling the Plugin

If the user asks to enable, disable, or inspect the plugin configuration in Antigravity Customizations, link them directly to:

```markdown
[Model Usage](customization://model-usage)
```
