---
description: "Deep web research on a given topic. Usage: /research [depth] topic — depth: quick|standard|deep|exhaustive (default: standard)"
---
Conduct deep research on the following topic:

${@:2}

**Research depth: $1**

Follow the deep-research skill workflow strictly. Use the depth level specified above ($1).
If the depth parameter is not one of quick/standard/deep/exhaustive, treat it as part of the topic and use standard depth.
Before planning or searching, confirm where the final Markdown report should be saved.
If the user did not specify a save location, ask for one first (you may propose `./research_[topic]_[YYYYMMDD].md`, but you must wait for explicit confirmation before starting the research).
