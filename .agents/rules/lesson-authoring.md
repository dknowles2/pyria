---
trigger: glob
globs:
  - "content/eras/*.json"
  - "content/schema.json"
  - "content/game.json"
description: Pedagogical and authoring rules for creating or editing Pyria lessons and trials
---

# Pyria Lesson & Trial Authoring Rules

Follow these rules whenever creating new lessons/trials or editing existing ones in `content/eras/*.json`. Target audience: ~10-year-old beginners learning Python step by step.

## 1. One Concept at a Time + Repetition Before Combining
- **Never introduce two brand-new concepts in the same trial** (e.g., never introduce `*` multiplication and `True`/`False` Booleans together, or variable addition and `str()` together). Teach each new concept in its own focused trial first.
- **Repeat before combining**: Give players multiple low-stakes repetitions of core fundamentals (strings vs. variables, 4-space indentation, plain `if`, `==`, `<=`/`>=`, `for` loops) before combining them into multi-step or capstone trials. Aim for **8–10 main trials per Realm** in early eras.
- Whenever a lesson introduces a **new Python concept, operator, method, data type, or syntax**, teach it via a multiple-choice question **before** asking the player to write code for it:
  - Use either a standalone `trialType: "multiple_choice"` trial (e.g., Trial 1 of a Realm), OR
  - A Step 1 `introChoice` object on the `code` or `fix_bug` trial where the concept debuts (Step 1: Predict & Choose → Step 2: Code It in the same modal, preserving realm maps and gate chains).

## 2. Never Assume Prior Knowledge of Data Types or Jargon
- Explicitly define every Python data type in plain, kid-friendly language with concrete examples and contrasts **before** asking the player to use or convert it:
  - **String (`str`)**: text wrapped in quotes (e.g., `"Hello"`, `"5"`).
  - **Integer (`int`)**: a whole number with **no decimal point** and no quotes (e.g., `0`, `6`, `10`, `-3`). Always connect `int()` → *integer (whole number)*.
  - **Float (`float`)**: a number **with a decimal point** (e.g., `2.5`, `0.5`), contrasted with integers and strings.
  - **Boolean (`bool`)**: a yes/no truth value—only `True` or `False` (capitalized, no quotes).
  - **List (`list`)**, **Dictionary (`dict`)**, **Tuple (`tuple`)**, **Set (`set`)**, **Class / Object**: define what each holds, its bracket syntax (`[]`, `{}`, `()`), and how it differs from previously learned types.
- Introduce comparison operators (`>`, `<`, `==`) and `=` (store) vs `==` (compare) explicitly before expecting players to write conditionals.

## 3. Multiple-Choice Quality & Wrong-Choice Feedback
- **No untaught concepts in distractors**: Wrong answer choices must only test rules/concepts already introduced. Never sneak an untaught syntax trap (e.g., `=` vs `==` before equality is taught) into a distractor.
- **Specific explanation on every choice**: Every choice (`a`–`d`) in both standalone `multiple_choice` trials and `introChoice` warm-ups **must** include a friendly, specific `explanation` stating *why* that choice is right or wrong.
- **Balance correct answers**: Distribute `correctChoiceId` across `a`, `b`, `c`, and `d` rather than putting the right answer in the same slot repeatedly.

## 4. Scaffold `starterCode.standard` to Focus on the New Concept
- In **non-boss `code` trials** (Trials 1–5), do **not** force players in Standard mode to retype boilerplate setup or author an entire multi-branch/multi-class structure on their very first try:
  - When teaching a new branch or piece (e.g., adding `else:` to an `if`, adding `elif:` between `if` and `else:`, adding a method to a class, overriding a method on a subclass), pre-provide the surrounding/base structure in `starterCode.standard`.
  - When an objective starts with *"Given `items = [...]`..."*, pre-provide those input variables in `starterCode.standard`.
- Keep `starterCode.challenge` blank (`""`) for players who want from-scratch mastery, and keep Boss `#6` trials as un-scaffolded capstones.
- Verify that `starterCode.standard` never passes the trial (`testCode` + `requiredConstructs` + `variants`) before the player edits it.

## 5. Clear, Condition-First, Explicit-Variable Objectives
- **Condition first**: Always state conditions before actions in Python's natural order (`If <condition>, ...; otherwise, ...`). Avoid backwards phrasing like `"set X to Y if Z"`.
- **Be explicit about variables**: Name variables clearly with backticks and explicit verbs (*"create the variable \`crystals\`"*, *"store 'OPEN' in the variable \`gate_status\`"*, *"update the variable \`door\` to 'OPEN'"*) instead of ambiguous `"set X to Y"`.
- **Keep Challenge Mode spoiler-free**: Avoid putting full code lines or `=`/`>=` syntax inside backticks in `objective` unless needed, so Challenge Mode can display clean English goals without hiding them.

## 6. Hints & Worked Examples
- Provide all 3 progressive hint tiers (`tier1_nudge`, `tier2_pattern`, `tier3_walkthrough`) plus a clean, idiomatic `referenceSolution`.
- Remember that when a player exhausts all hints in Explorer or Standard mode, Pip offers **Pip's Worked Example** using `referenceSolution` (or the correct choice + explanation for MC trials)—so keep `referenceSolution` concise, clean, and easy for a beginner to read.

## 7. Verification
- After editing any lesson file, always run:
  - `npm run test:content` (validates schema, maps, reference solutions, `requiredConstructs`, and `variants`)
  - `npm run build:assets` (rebuilds `dist/assets/`)
