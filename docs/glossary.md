# Glossary

Plain-English meaning of every product term we use. The head agent adds new terms after each slice. Alphabetical. Words about agents and git (slice, worktree, pull request) are defined in `docs/agents/glossary.md`, not here.

- **BAA (Business Associate Agreement):** a HIPAA contract where a vendor promises to protect health data. Needed with Deepgram or OpenAI before real patients (slice 000)
- **Bleeding on probing:** the gum bleeds when the probe touches it, a sign of disease. Spoken "bleeding" after a depth, typed as `b` (slice 000)
- **Earcon:** a short sound that means something: a tick for accepted, a buzz for refused (slice 000)
- **Endpointing:** how the speech service decides a phrase is over: 300 ms of silence here (slice 000)
- **Focus guard:** in live mode, PerioKey types only when the dental software's window is in front, and pauses if it is not (slice 000)
- **Glued digits:** the speech service writes "323" for "three two three". PerioKey splits it only when there is one possible reading (slice 000)
- **Perio chart:** the gum health chart: a pocket depth in mm at 6 sites per tooth (slice 000)
- **PMS (practice management software):** the dental office's main program, for example Patterson Eaglesoft (slice 000)
- **Pocket depth:** how deep the probe slides between gum and tooth, in mm. 1 to 3 is healthy; 10 to 15 is rare and severe (slice 000)
- **Practice mode:** nothing is typed into other apps; the page shows the keys and fills its own chart (slice 000)
- **Profile:** one JSON file in `profiles/` that says which keys a dental program uses (slice 000)
