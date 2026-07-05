# Douyin Promo Video Design

## Goal

Create a short vertical promo video for AI Token Dashboard that fits Douyin pacing and drives three actions:

- Comment interaction: ask viewers how many AI coding tools they use.
- Local trial: make the tool feel easy and safe to run locally.
- GitHub Star: make the final call to action point clearly to the open-source project.

The primary audience is AI-heavy developers who already use tools such as Claude Code, Codex CLI, Gemini CLI, OpenCode, Hermes Agent, or OpenClaw, plus adjacent open-source technical viewers who may star or share the project.

## Format

- Output: MP4 video rendered from HyperFrames.
- Canvas: 1080 x 1920 vertical.
- Duration: 25 seconds.
- Language: Chinese on-screen copy.
- Style: punchy technical short video, not a slow product tour.
- Audio: optional music bed can be added later; the core video must work silently with kinetic text and visual rhythm.

## Positioning

Core message:

> 别再凭感觉猜 AI 用量了。一个本地看板，统一看清 token、成本、模型、项目和订阅额度。

The video should avoid sounding like a generic dashboard announcement. The hook should frame the product as a practical answer to a real AI-heavy developer problem: several agents are running every day, but usage, cost, and quota are scattered.

## Narrative Arc

### 0-3s: Hook

Purpose: stop the scroll.

Visuals:

- Dark, high-contrast opening.
- Large kinetic headline: "你知道 AI token 花去哪了吗？"
- Tool names quickly enter around the title: Claude Code, Codex CLI, Gemini, OpenCode, Hermes, OpenClaw.

Copy:

- "你知道 AI token 花去哪了吗？"
- Secondary flash: "几个 Agent 一起跑，账本却是散的"

### 3-8s: Product Reveal

Purpose: show that the project unifies scattered usage.

Visuals:

- Transition into a warm dashboard-inspired canvas.
- Show compact cards for total tokens, cost, active tools, and top models.
- Show a "Collect" action pulse to communicate in-app local collection.

Copy:

- "一个本地看板统一看"
- "Claude / Codex / Gemini / OpenCode / Hermes / OpenClaw"

### 8-14s: Useful Views

Purpose: show depth without becoming a feature list.

Visuals:

- Fast scan through dashboard-like panels: trend chart, source donut, model ranking, project/session table.
- Then briefly switch to review-page framing: printable retrospective, calendar, tools distribution.

Copy:

- "token、成本、模型、项目"
- "看板 + 复盘，两种视图"

### 14-20s: Trust and Privacy

Purpose: turn skepticism into trust.

Visuals:

- Shift to a calmer technical trust frame.
- Local file paths and SQLite/database motifs move into a protected local box.
- Optional multi-device hub appears as a secondary path, clearly marked optional.

Copy:

- "默认本地读取日志"
- "SQLite 聚合，不上传、不遥测"
- "多设备汇聚也可选"

### 20-25s: Open Source CTA

Purpose: convert.

Visuals:

- Return to strong dark technical ending.
- Show product name "AI Token Dashboard" / "Token Studio".
- End with GitHub-style CTA and comment prompt.

Copy:

- "开源，本地优先"
- "GitHub 搜：AI Token Dashboard"
- "评论区：你现在用几个 AI 编程工具？"

## Visual Identity

The video should borrow from the product UI but be more energetic for Douyin:

- Backgrounds: alternate dark technical frames and warm dashboard-paper frames.
- Product colors: warm paper, black ink, indigo, violet, teal, amber, rose.
- Typography: bold Chinese display text for hooks; compact sans-serif UI typography for dashboard panels.
- Motion: quick entrance rhythm, sharp transitions, no static slide deck feeling.

Anti-patterns:

- Do not make a marketing landing-page hero.
- Do not use generic AI imagery, robots, abstract glowing spheres, or stock-looking backgrounds.
- Do not over-explain installation steps.
- Do not show tiny unreadable UI screenshots as the main visual; recreate simplified dashboard panels sized for mobile video.
- Do not imply data is uploaded by default.

## Implementation Shape

Use HyperFrames as the video source of truth:

- Create a dedicated video project under a project-local video directory.
- Define a `DESIGN.md` before writing composition HTML.
- Build one 1080x1920 root composition with five timed scenes.
- Use GSAP timelines for kinetic text, panel entrances, and scene transitions.
- Use simplified recreated UI panels instead of depending on a running app screenshot.
- Run HyperFrames lint, inspect, and render checks before delivery.

## Success Criteria

- The first three seconds make the problem understandable without sound.
- Every major product claim maps to existing project functionality in the README or source:
  multi-source collection, dashboard/review views, cost tracking, in-app collection, local-first privacy, optional multi-device hub, subscription quota cards.
- Text remains readable on a phone screen.
- The final frame has one clear primary CTA: GitHub search or Star.
- The video feels like a Douyin technical short, not a slow SaaS promo.
