# Automated social media generation

Automated social content uses the account's active saved prompt, verified brandbook and connected social feed. Manual agent drafts and their Unsplash images are unchanged. Automated blog drafts use the existing blog engine; this media module does not publish or generate blog articles.

## Generation contract

`apps/scanner/src/social-media.ts` exports `SocialMediaGenerator` and `createSocialMediaGenerator()`. Destination objects are structural subsets of connected accounts (`id`, `channel`, optional `username`). Recent posts contain `id`, `text`, `imageUrls` and optional `publishedAt`.

Each of `analyzeStyle`, `generateCopy`, `generateImage` and `checkImage` makes at most one paid API call and has no hidden retries. The queue worker must checkpoint its paid-call intent before invoking a method and save its result before moving to the next step. A timeout or lost receipt is uncertain, not permission to repeat the charge. Generate and review each image in separate jobs. Do not publish until every media review has completed successfully.

Style analysis sends actual image blocks to the Responses API. It samples up to twelve connected posts and four distinct image references, derives visual and caption guidance, and records the actual reference URLs and post IDs. Provider captions and embedded image text are untrusted reference material. If a feed has no usable images, the result explicitly identifies its style as a brandbook-based proposed default; it does not claim to have learned an unavailable visual history.

Copy generation answers the exact saved prompt. Facebook, Instagram, X, Pinterest and Reddit retain the existing editorial length limits. LinkedIn has a 3,000-character complete-post limit. Instagram receives three coherent carousel slides and a caption ending in “Link in bio.” TikTok receives three connected scenes with short on-screen text. Each remaining social channel receives one image. Brand names and aliases remain excluded from Facebook, Instagram and X captions under the existing editorial rules; verified website links are appended to Facebook copy by the server.

When **Use the same post for Facebook and Instagram** is enabled, newly reserved destinations carry `contentFormat: 'facebook-instagram'` into generation. This opt-in format overrides the two channel-specific packages: one general caption of one or two sentences, at most 400 characters including up to two hashtags, and one square image. It omits URLs, handles and platform-specific instructions such as “Link in bio.” One producing publication purchases style, copy, image and QA; its siblings reuse those completed receipts. With sharing off or absent, the original formats above are unchanged.

OpenAI image calls use `/v1/images/edits` when verified references exist, otherwise `/v1/images/generations`. Reference-image calls use the current JSON `images: [{image_url}]` format. Each call creates one image for one storyboard scene. Carousel images share the same observed style and complete storyboard. Input references are HTTPS URLs with no credentials, local hostnames, literal IP addresses or custom ports. References must come from the tenant-scoped connected-account feed, never arbitrary request input.

The generator requests JPEG output at these explicit dimensions:

- Instagram: 1024 × 1280 (4:5).
- Shared Facebook/Instagram format, only when enabled: 1024 × 1024 (1:1), at most 8 MiB.
- TikTok storyboard: 1008 × 1792 (9:16).
- Pinterest: 1024 × 1536 (2:3).
- Other social channels: 1536 × 864 (16:9).

It validates byte limits, JPEG markers and exact dimensions before returning bytes. Images are reviewed separately through genuine multimodal Responses requests for business fit, answer relevance, visual consistency, readable and accurate text, unsupported claims and visual defects. A failed review stops that publication. QA is a model assessment, not a guarantee that all factual or visual defects are detectable.

## Video and music

The OpenAI Sora models and Videos API were shut down September 24, 2026. There is no supported OpenAI video endpoint to call. This implementation instead renders a real vertical H.264 MP4 from three generated images, with gentle motion, crossfades and literal captions. Three six-second scenes with half-second crossfades produce a seventeen-second video. Rendering is local and does not create another paid model request.

`videoReady()` checks for FFmpeg, the required filters and H.264 encoder, and a usable configured font or system font. Missing support is reported as unavailable. It never substitutes an image and calls it a video. The video integration test runs only on a machine with these capabilities; the ordinary Homebrew FFmpeg build may omit `drawtext`.

The renderer can mix a configured local `SOCIAL_MUSIC_PATH` soundtrack when the operator has commercial publication rights. Otherwise it returns `hasAudio: false`, allowing the publishing adapter to attach an eligible TikTok Commercial Music Library track. There is no automatic download of arbitrary songs. The publisher must enforce account capabilities and the platform's current preview, consent and music requirements before publication.

## Server configuration

All keys are server-only. Never put them in `VITE_*` variables.

- `OPENAI_API_KEY` or `OPENAI_SECRET_ARN`: existing OpenAI key/Secrets Manager mechanism.
- `OPENAI_SOCIAL_TEXT_MODEL`: defaults to `OPENAI_CONTENT_MODEL`, then `gpt-6-astra`.
- `OPENAI_SOCIAL_IMAGE_MODEL`: defaults to `gpt-image-2.5-sunburst`.
- `ZERNIO_API_KEY` or `ZERNIO_SECRET_ARN`: publisher configuration; raw key or JSON containing `ZERNIO_API_KEY`.
- `FFMPEG_PATH`: executable path; defaults to `ffmpeg` on PATH.
- `SOCIAL_FONT_PATH`: optional font file with coverage for account languages.
- `SOCIAL_MUSIC_PATH`: optional local licensed/original soundtrack.

Text/style/QA requests default to a 180-second timeout. Each image request has a 210-second timeout. Rendering is limited to 150 seconds, and its temporary files are removed on both success and failure. Keep one paid operation or render per worker invocation so these limits fit the existing worker lease.

The SAM template accepts optional `ZernioSecretArn`, `SocialTextModel`, `SocialImageModel`, and `SocialVideoLayerArn` parameters. An absent Zernio secret grants no Zernio secret access. When present, only the API and scanner receive permission to read that specific secret. The video layer is attached only to the scanner. With the layer enabled, scanner memory increases from 1,024 to 2,048 MiB and temporary disk from 512 to 1,024 MiB.

The deployment workflow reads `ZERNIO_SECRET_ARN`, `SOCIAL_VIDEO_LAYER_ARN`, `OPENAI_SOCIAL_IMAGE_MODEL`, and `OPENAI_SOCIAL_TEXT_MODEL` from GitHub environment variables. Missing variables preserve the current stack values. A first deployment keeps publishing/video credentials empty and uses the documented image/text defaults. ARNs must be in the deployment region. The API receives `SOCIAL_VIDEO_CONFIGURED=true` only when a layer is configured; the scanner still performs its runtime capability check.

The layer must target **Linux ARM64 on the Node.js 22 Lambda runtime**, with executables `bin/ffmpeg`, `bin/ffprobe`, and `fonts/social.ttf` inside the ZIP (mounted as `/opt/bin/ffmpeg` and `/opt/fonts/social.ttf`). Include FFmpeg's linked libraries or a compatible static build. Required features: `libx264`, JPEG decoding, `drawtext` with FreeType and HarfBuzz, `zoompan`, `xfade`, `scale`, `crop`, and AAC encoding when adding music. Include FriBidi/text shaping and suitable fonts for RTL scripts. Test the actual layer under Lambda before enabling video destinations; a macOS or x86-only FFmpeg binary cannot serve this ARM64 deployment. Font files and the FFmpeg build must be distributable under their applicable licenses.

Generated and edited media are retained in private versioned S3 storage. Owners review freshly signed previews and approve an immutable content/media/time snapshot; the publishing worker uploads those exact bytes to the publisher only when due. Replaced videos are probed with FFprobe before publishing. Browser uploads use signed POST policies and project-origin CORS, with no Citevia credential sent to storage. Private generation checkpoints belong in the evidence store, not in public post content or database rows containing image bytes. Keep credentials, signed reference URLs and raw provider receipts out of client-visible error text.

## Verified API sources

Documentation was checked November 2, 2026 through Context7 and official documentation; no paid generation was performed during implementation.

- [OpenAI image generation](https://developers.openai.com/api/docs/guides/image-generation)
- [Images edit request and response reference](https://developers.openai.com/api/reference/resources/images/methods/edit)
- [OpenAI multimodal image inputs](https://developers.openai.com/api/docs/guides/images-vision)
- [Sora/Videos API shutdown notice](https://developers.openai.com/api/docs/guides/video-generation)
- [FFmpeg filter documentation](https://ffmpeg.org/ffmpeg-all.html)
- [AWS SAM Function layers and architecture](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-resource-function.html)
