# NOTICE

talkdude is licensed under the GNU General Public License v3.0 or later (see `LICENSE`).

talkdude began as a fork of **Lumi AI** by Looper (iamlooper),
https://github.com/iamlooper/Lumi-AI, which is licensed under the MIT License.
The MIT license text and copyright notice are preserved below as required.
All modifications made in talkdude are Copyright (c) 2026 Ariastiadi and are
distributed under the GPL-3.0-or-later.

## Third-party assets

- **Doto** dot-matrix font (subset, embedded in `src/theme.css`) — Copyright 2024
  The Doto Project Authors (https://github.com/oliverlalan/Doto), SIL Open Font
  License 1.1.
- **Google Sans / Google Sans Text / Material Symbols** fonts in `public/fonts/` —
  carried over from Lumi AI; see Google's font licenses.

## Original Lumi AI license (MIT)

```
MIT License

Copyright (c) 2026 Looper

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## wllama and llama.cpp

On-device models run with [wllama](https://github.com/ngxson/wllama) (MIT, © 2024 Xuan Son Nguyen), a WebAssembly build of [llama.cpp](https://github.com/ggml-org/llama.cpp) (MIT, © The ggml authors). Their WebAssembly binary is bundled with the app.

Model weights are not bundled. They are downloaded on request from Hugging Face and keep their own licenses: Qwen 2.5 (Apache-2.0) and Llama 3.2 (Llama 3.2 Community License, "Built with Llama").
