# UIL Spelling Coach

A free practice site for the **2026–2027 UIL A+ Spelling list** (grades 3–8, all 2,300 words).

**Live site:** https://sav-krish.github.io/Spelling-Bee-Helper/

## What it does

- **Spoken tests.** A pronouncer voice reads each word ("Number 3. Hare, as in rabbit. Hare."). Clarifiers from the official list (homonyms like *hare (rabbit)*, *desert (abandon)*) are always read.
- **Type your answer.** The spelling is never shown during the test. Results appear only at the end.
- **Practice or Contest rules mode.** Practice gives buttons for *Say again*, *Use in a sentence*, *Meaning*, *Say slowly*, and a recorded human pronunciation when available. Contest mode follows UIL rules: the word, a sentence, and the word again, read once with no repeats.
- **Per-word timer** (default 30 s). It pauses while the pronouncer is talking.
- **Grading follows the UIL rules.** Capitalization, hyphens, and apostrophes must be right. A blank counts as a miss. Either listed spelling (e.g. *nosy, nosey*) is accepted.
- **Missed words.** Every miss is saved. Practice them anytime, and a word leaves the list once you spell it right.
- **Every word gets used.** Each grade division is a shuffled deck, so all words come up before any word repeats.
- **Grade picker:** 3–4, 5–6, 7–8, or all. Pick 10, 25, contest size (50/80/110), or a custom number of words, plus an optional tie breaker (15/20/30).
- **Printable PDF:** a pronouncer's list (word, meaning, sentence) and a numbered answer sheet for paper practice.
- **No login.** Progress is saved in your browser (localStorage).

## Notes

- Speech uses your browser's built-in voices (best in Chrome, Edge, or Safari). Pick a voice and speed on the home page.
- Definitions and recorded pronunciations come from the free Dictionary API (Wiktionary, CC BY-SA). Example sentences were written for this site.
- The official authority for spelling is Merriam-Webster's Intermediate Dictionary.

Plain static site with no build step. Open `index.html` or serve the folder.
