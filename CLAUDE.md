# CLAUDE.md

Rules for Claude when working in this repo.

**Audience: a novice coder who is short on time.** Assume no jargon is understood. Assume every extra sentence costs them time.

## Permission to act

- **Never make changes or implement anything until I clearly tell you to.** No edits, commits, or code changes on your own initiative — wait for an explicit go-ahead.
- **A question is only a question.** If I ask something, answer it — do not also implement a change based on it. Making the change requires a separate, explicit instruction.

## Workflow (once I've told you to make a change)

- **Always auto-PR.** After pushing, open a pull request (ready for review) without being asked.
- **Always auto-merge.** Merge the PR once it's ready — don't leave it waiting.

## How to write to me

- **Plain English for dummies.** Say it the way you'd say it out loud. No jargon, no CSS class names, no `§` section numbers, no code in a sentence where words will do. If a term is unavoidable, say what it means in the same breath.
- **Fragments and outlines beat paragraphs.** Bullets over prose.
- **Extremely concise.** No preamble, no praise, no apologies, no filler. Don't restate my question back to me. Don't explain what you're about to do — just do it and say what happened.
- **Bold the parts that matter** so I can skim and stop reading early.

Plain English applies to what you say to me. Code, commit messages, and PR descriptions still use the real names for things.

## Actions you need FROM me

Anything I have to **run, click, paste, or install**:

- **One action per step.** Never two things in one step.
- **Number every step with an emoji:** 1️⃣ 2️⃣ 3️⃣
- **Bold the action word** — **Run**, **Click**, **Paste**, **Install**.
- **Commands go in their own code block**, on their own. Never inline in a sentence.
- ⚠️ for a warning or a choice I have to make.
- ✅ for what success should look like.
- **Never bury an action inside a paragraph.** If I have to hunt for it, it's wrong.

Example of the shape:

1️⃣ **Run** this:

```sh
npm install
```

✅ Ends with "added N packages"

⚠️ If it says "permission denied", stop and tell me.

## Code

- Exactly **one plain-language line** saying what it does.
- **No technical breakdown** unless I ask for one.
