# Third-party content

The code of المُسَمِّع is licensed under the [GNU AGPL-3.0](LICENSE). The content below is **not** covered by that
licence: it keeps its own terms, and is listed here with the credit it is owed.

| Content | Where | Source | Terms |
|---|---|---|---|
| Quran text, 8 riwayat | `data/riwayat/<key>/data.json` (as published); `client/public/riwayat/<key>/*.json` (built by `scripts/build_riwayat.py`) | King Fahd Glorious Quran Printing Complex (KFGQPC), [Quran developers platform](https://qurancomplex.gov.sa/quran-dev/), via [thetruetruth/quran-data-kfgqpc](https://github.com/thetruetruth/quran-data-kfgqpc) | KFGQPC makes its digital mushaf free to use «في مواقع الإنترنت والبرامج الحاسوبية» inside and outside the Kingdom ([usage rights](https://dm.qurancomplex.gov.sa/rights/)). The app shows the text exactly as published (field `t`); `c` is a letters-only key for matching speech, and `mutashabihat.json` / `diff.json` are computed from the text. |
| KFGQPC Uthmanic fonts, 8 riwayat | `data/riwayat/<key>/font.woff2`, `client/public/riwayat/<key>/font.woff2` | KFGQPC (same source) | Free to use, copy and distribute, never sold or modified: see [FONT-LICENSE.txt](client/public/riwayat/FONT-LICENSE.txt). The files are byte-identical to the source. |
| Recorded recitations and their ayah timings | not stored: streamed at run time | [mp3quran.net](https://mp3quran.net) CDN and its [API v3](https://mp3quran.net/api) | The recordings belong to their reciters and publishers. The app plays them from mp3quran.net and keeps no copy. |
| Tafsir of Ibn Juzay (d. 741 AH) | **not in the public repository**; `scripts/export_tafsir.py` builds it from a local copy of al-Maktaba al-Shamela | «التسهيل لعلوم التنزيل» لابن جُزَيّ الكلبي، تحقيق علي بن حمد الصالحي، دار طيبة الخضراء، مكة المكرمة، ط١ ١٤٣٩هـ / ٢٠١٨م ([Shamela](https://shamela.ws/book/30186)) | The work is centuries old; this edition's vowelling and punctuation are the editor's. The owner's deployment serves it per ayah, with this credit. |
| Other tafsirs, البدور الزاهرة, النشر, الإتقان | **not in the repository**; read live by `server/` | the owner's own copy of al-Maktaba al-Shamela | Each book belongs to its rights holders. The library API runs only on the owner's computer, for the owner's sessions. |
| Tajawal, Reem Kufi | loaded from Google Fonts | [Google Fonts](https://fonts.google.com) | SIL Open Font License 1.1 |
| npm packages | `package.json`, `client/package.json` | npm | React, React DOM, Vite, @vitejs/plugin-react, Express: MIT · lucide-react: ISC · @google/genai, TypeScript: Apache-2.0 · dotenv: BSD-2-Clause |

The live teacher is Google's Gemini Live model, used under Google's
[Gemini API terms](https://ai.google.dev/gemini-api/terms): each user brings their own key and accepts those terms.
