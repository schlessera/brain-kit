/** Fixed offline transport for the existing nineteen-package consumer probes. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, lstatSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, posix } from "node:path";
import ts from "typescript";
import { buildRead } from "./ci-build-files";
import { captureOutputs, identity } from "./ci-build-boundary";
// Exact extra consumer records from official version metadata and verified
// tarballs. These qualify dependency preparation only, never build reuse.
const extraConsumerIntegrities: Record<string, string> = {
  "@anthropic-ai/claude-agent-sdk@0.3.304": "sha512-Ivkt7/UAkATibzvqT31eY71lAp7YdPzfbKDpmbHN9+AQWFh/Ac6tYkL2J1sipJ7tU4IK48w0YxuRW9aI//veFA==",
  "@anthropic-ai/claude-agent-sdk-linux-x64@0.3.304": "sha512-72SZA+TYtrDCXM7j8GNaoUpZrtysxw8FiunRv6C59wJRkhpxzlYLGrjser7vX6ivK+LiBkVU/V3wzEyfJqB4sA==",
  "@anthropic-ai/claude-agent-sdk-linux-x64-musl@0.3.304": "sha512-cNZvVaVw5ly/sduYj+c2ekrqnpzqUBLsQapvpXhVFy6hjdwXhj8gCNmr5Wta5tlTrNEo0C2kxvfFm+GjD7Tcvg==",
  "@aws-sdk/core@3.978.4": "sha512-JvGp6y9sPX8FSs2K/EmFMZcUfdkHxqGE45+oxwGC75OIh50j2e4cbx7zcR3BwNs2DSGqJdBja5h6Vy89iIDmRQ==",
  "@aws-sdk/credential-provider-env@3.972.75": "sha512-nc8Epg98PcYoKNx0VFlwtmZSCP+tuJ1FLWqpslET/gp4h/WYuULSJqtxppM6ywKKDdzNJPvLD7ceRfmxm3Qdxw==",
  "@aws-sdk/credential-provider-http@3.972.77": "sha512-KkYFdIQwuw9IOHfEzK78slxmVWuhcm1w6YgE3V3WVxAeRRj9q5J9jlwzpY/oszWxd4SD96FTFkDdRGBdMFF2Mw==",
  "@aws-sdk/credential-provider-ini@3.973.20": "sha512-OSl2R/0zLkoeKEIy6oP2tu/bsSdY+DGgro2eOffMD2CcP8POv7rS14FY5Jzc5bjnqB1G9wv/aM1akHC2mdlhZw==",
  "@aws-sdk/credential-provider-login@3.972.82": "sha512-8jyDPtf1WPxeQ/5xlNpyxAD6P7YKwkYeNk8B2vFEDwkPWDvb7c3tQJG5/jbNWbF2yTMIH9tDTueBkdfovYIAPw==",
  "@aws-sdk/credential-provider-node@3.972.87": "sha512-TKj2C0x4IMPSSOAlmeryX8fCPvvPS2pFJz2ikV9IGqyh6Ehsg4leMalCTVfV2rvMTrlGAe7X7nK0HZ3P0KZR9g==",
  "@aws-sdk/credential-provider-process@3.972.75": "sha512-ZNm8T/HJNhpS8MikDVAsym8QyUSUuOUGiCkmI3TTya7G6xhOgfRLd2iK91HhQQyvRM36eo6Xm845hHVyfToA2w==",
  "@aws-sdk/credential-provider-sso@3.973.19": "sha512-qHGDAGesyWtRw3BapyFkYSUzVNrC1CWPS6+S2lf/MLMEkWB2gR3Bl6imVHy1nhImXKS+gcuUDzbu39BnsHJc1Q==",
  "@aws-sdk/credential-provider-web-identity@3.972.81": "sha512-nHkgkMIC6NHgqfI6UAQq5cCS4bUkNxkT+r9fXCq/X4IKfX/DHGZ8UM3T4b78OXpWK5OlzEzN4kxwyax0W/MUCA==",
  "@aws-sdk/eventstream-handler-node@3.972.37": "sha512-vU0v4d6anhLqBCpPq7Q7hD2Av3/5qOR5O30Ze8ALLysgB3iMQTPHQ/P2aTgfrY2ZjnVJUCi7NiTSNqa1mDF+5w==",
  "@aws-sdk/middleware-eventstream@3.972.32": "sha512-D3ayeW/K2lTQI8+SyzDvAKfM3N4SFJjfgqeHbS3DOZmmQebZyve6WUyJiqOKqeOxmIcFxTzpSdsijnRF035J3g==",
  "@aws-sdk/middleware-websocket@3.972.57": "sha512-mPNUOedufUwZXISOEySSP7l7owyY0Ypp1ajsd1GsB4E5Vpaf8NtfmmNygyPPeGPsRZ1sOcS90aAhQ03yPy/pFg==",
  "@aws-sdk/nested-clients@3.997.49": "sha512-zjqIqzTYLRKhT7TPJDUreK9vG9PjhmnfLCaTaqArkRT7j+Ogl0tuXB7MpSd8rlRfRT+xTOeyNFWaOfyNcf51hg==",
  "ignore@7.0.13": "sha512-2E8Q6rh+1RRSq/YdaGsNfXsEZy9FVqv6BSSrkmZJP7BnaoPnRfKL+YaofPvP+5rzdk144qSm6i4+hvPgUcbV4Q==",
  "@aws-sdk/token-providers@3.1153.0": "sha512-6bKJ2OfLboxhzeJ3hBDeB8L6emCYf9DfdrjBAharLrY42J1RV/6jA6G8jvfNghzID8Yb40BdSY7jQMtWx9Ot0Q==",
  "@anthropic-ai/claude-agent-sdk-linux-x64-musl@0.3.302": "sha512-UCsqTcoUmV8qGdnmw0od2grDPgrkK6kclpo5Oyox15B9glHXhOIL0nifWcw2xS9VKV0VZ11I9FujPLIXfEpXtg==",
  "@anthropic-ai/claude-agent-sdk-linux-x64@0.3.302": "sha512-HqD0+tnjJDldkZJPuTiMIZ1XbrVW8LH/3QKqCBgXLGwVFNgkLOM+Sfh14C0vqyZSIaLFgsFd4bIw1jg5V+td6w==",
  "@anthropic-ai/claude-agent-sdk@0.3.302": "sha512-VUxgraOIxnu4COhS9IkP3AF21kh9KOOF8oyU7pc6q0PfzMPlarbnhXvuhCNIPPYddhIev+17LLq1nZ700GdLBg==",
  "@aws-sdk/core@3.978.3": "sha512-nslpzUCTI9b2IQMWSd6mSAXldBexPc8rr0d3dXUutXYFLFaTdsHa2GD7sJdsn3PhyjK0O5K8ypd6zi+RXXPVlg==",
  "@aws-sdk/credential-provider-env@3.972.74": "sha512-rsRJcW2iFUhCgclyD6OSbMEaPl8Eu0qSeRZb2uuCK1ViZ66hl5wOe/p6Vr6MO3b+ydyKgFeqza2p6tZThvILlw==",
  "@aws-sdk/credential-provider-http@3.972.76": "sha512-pnKdh0Br7OJPj+7qKjzgTfDTFW0RhEMKXNDR2jv9CAM4oHuG/4z3hRh8KtutLfpmItuRtDbKBmwWkDqHwwAWXw==",
  "@aws-sdk/credential-provider-ini@3.973.19": "sha512-kcjvAxqQEV8yuwkX58RelNn3ne65o7JgRWf3Z/gVvbi7Xuw1qSDLJlatrLD76+40cmRxmNkLxBoyp/vAQChQ5g==",
  "@aws-sdk/credential-provider-login@3.972.81": "sha512-CeQHSbE2CnVdaHIJ/NayRaCecIER+Pm9faUPkmRATO54rCoMTEPSbVieGHzEwvm1dZM2HIs6qQZCznhayNTWJQ==",
  "@aws-sdk/credential-provider-node@3.972.86": "sha512-WNttSyr6e8innPtBSty//CdnqJcgZN6eAbtw3v/CR2IObz6MYZEo8eusdtuCHJ2ujwFqC2bSPHVyhXGHx8HruQ==",
  "@aws-sdk/credential-provider-process@3.972.74": "sha512-Yj6kZFJQdbR+PygTkqdVLPHHpdDpOS9GCYVcDCuweCRRig9LF24ELQBMfyUw1vspvrZJUfnOGVyMjhaL094ahw==",
  "@aws-sdk/credential-provider-sso@3.973.18": "sha512-FnpPhdY4qUGtX/8X6eKxh+uD+9Y19i9FYibgk4SBe0M935s9vocHkHzaxaMNk+YkHmvzgdu8cHA5SCoeU+kkew==",
  "@aws-sdk/credential-provider-web-identity@3.972.80": "sha512-TJF25Ndwy2HxcVj6oxMgp8qVlJAawlExHYBXqhuC6Zt2m+A7WpdkjBD6QglNbiArlteYljZHEY3R7KKmno6ISA==",
  "@aws-sdk/eventstream-handler-node@3.972.36": "sha512-HFaKXA6ugPVvpR7W/3UT3hylWIPndqGMwduwNVrmGsRT5+OESHN8/ven4eeofraQF5Kxp8A8QgGVrv7iQsTRKQ==",
  "@aws-sdk/middleware-eventstream@3.972.31": "sha512-4yvdTVwPGKCnrwuwlYEmwLqQXKwk0unx3f/FvBi4FA9ruK/WGoPJyqfK7hOYurheIyQL44FR0ovgOHqvkfdpAQ==",
  "@aws-sdk/middleware-websocket@3.972.56": "sha512-32d9EnnNM5UMwjVp/qnL0K4XYiZv+YlSbULI3BaoBdJvebAS6cD0bKfPJ7lzovN0qrelvmSh5jo/3tk0KoTuGQ==",
  "@aws-sdk/nested-clients@3.997.48": "sha512-B01jdXJtAW/XOiUzGdI2mz67WyEHbGEc9X6Euzw3bjLAa+txTqdZDER4X2FsIEcXzV2ABqudVZ5thali8tCCzQ==",
  "@aws-sdk/signature-v4-multi-region@3.996.48": "sha512-cFDXfEbXaGwbnpvR/DyqfxfjxpjXVRVthQLgkwvcfDS5u3+8G9WSj1X1Ag/pTRg/QOeOno1Tq3ycEdrKsCUcOA==",
  "@aws-sdk/token-providers@3.1150.0": "sha512-wDU36ofhabZYu+d2KSriyDbwzxNoaOp+4dG0p3qkabk7HeALR5nIWyQbjoyJZLn3iqWkv/xNdyUfbfevDVDzzg==",
  "@babel/runtime@7.29.10": "sha512-NpugTzbKgGrNe45Ui32cN8vCFFMxVtP/9rtfwv0nP5FRDAjvYBxJcLVpYA9mr1jxP6cnIT7x9LUzuDTbWYYNRA==",
  "@hono/node-server@2.1.5": "sha512-MgP/I06GdvsilDspMk/qmRzpk8LOUStP6jFAbSRi40W09DhoyUn+Mj7eyKICPqeYKybOjVFLVIAQzvu1bfIa7Q==",
  "@modelcontextprotocol/sdk@1.32.1": "sha512-2DdE+SJDtzLEEWzY1ZjY7Q+VcPhcV1KisD3zI4u0XZyktsjHum1mwbMI+JaulUBi2OZk+KJAi2uPXzxichPkdw==",
  "@napi-rs/canvas-linux-x64-gnu@1.0.11": "sha512-iDapw7nFSE5tsmQxcH2+KotJhyfVPmHd6vUOQN/Em+8WNbkZJwJ/rDowlJMFnMl0SYSDSfgKCNUGi6Sn5++Smg==",
  "@napi-rs/canvas-linux-x64-musl@1.0.11": "sha512-26q26AyITo3CGZX4HWFIMgBMA1lu3YN07gxzBm4tW6Hglq/OVyTP50kDrmWuKybCX6dh3m8Ly+c7YhI+sqCgCQ==",
  "@napi-rs/canvas@1.0.11": "sha512-vt5tog1cr+QKadIddGe+3LrcX0EmjEd0izF717Uwf92mBmgYfq2XRmL2r4bZU40spB69exxhrBn9I91HYEr/7w==",
  "@peculiar/asn1-android@2.11.0": "sha512-llW/qjavL+tOxt5i9whUv4wsbsLpUwI6k/DrvKsdA/H7A/TB/6CosMFgvei28fcJ8ncD0c5lig1oBBlo4KGMCw==",
  "@peculiar/asn1-cms@2.11.0": "sha512-SlAiDoT/Cd8qaNmbTt78gqyaEvu2fQd6ML6KWJkdjXGrgDKnHHrusVkfQUelkfinL2p665IIADb0JBixtT8W1g==",
  "@peculiar/asn1-csr@2.11.0": "sha512-M/ED0yJ05qMK+UADPKnIa8vhAeewOJALSxTAZB7RQ/batRHhIJZkwznCcWAbFO5saHJ1yEQ+m4lncEcG9RnQSg==",
  "@peculiar/asn1-ecc@2.11.0": "sha512-jj1alGEKev7/un+cI+exyVK9m31lmP7cCBMCZuCb0wkFQH2zmKmJzNiG4wqXFNzlcP8timHLnzf3lV3OxBpb/Q==",
  "@peculiar/asn1-pfx@2.11.0": "sha512-ykSAWRu8KkmzU8LRpk9ZQC3zuLmBEtoSMjIv9XHVamD5W7amqreV5wttKqnvtjWOzzSJQxA/HVT8/tHwpEEGSQ==",
  "@peculiar/asn1-pkcs8@2.11.0": "sha512-lragjkjQGnQ5luxC+sxoAfAO/jBiQ7hOEGlDKJUk7MC5zY3AzjB2DU0GyPUH1Sswdv10t7DurY0zylOYMLb88w==",
  "@peculiar/asn1-pkcs9@2.11.0": "sha512-gDdFjpqV0weJjgNUvueUVf4D8uVbpq+VbG0TsxLAY2QGljAkJyL9qwQ7avol9j0jaYSJ7Ey7v7RZp0M3GTcQSA==",
  "@peculiar/asn1-rsa@2.11.0": "sha512-S2sBJmbfI09Kzdt9cEhE6pDNjHpVTkURs+811+PxS8AvsTLxC4woMNRhxHYaIbClkkNfAVt0tZxJdINVfUmzuA==",
  "@peculiar/asn1-schema@2.11.0": "sha512-8xh4avo53/vXO6UEv9yaoJ83hY581geaLTygf61NPIXP5AeIZCPjJhpTaYU23IZkG+NpLN/C9FYzWp7hphIT9A==",
  "@peculiar/asn1-x509-attr@2.11.0": "sha512-Fgvnd9REmLxEj/4cbDP54dNUNUXkzUksXLqEHqs1mHBuSRjSTCUSPM/WQIZYSvrdG7ND9CX1AQtPoIBekhgQSA==",
  "@peculiar/asn1-x509@2.11.0": "sha512-J1sHAwGNlk+8J+FeR1eLVc6Gq0T9f9ITc3HWyPYgJraoW6U8AJuQiWVJ3SCEpltfTdpOY7fHdHT5oKAsbK/jww==",
  "@puppeteer/browsers@3.2.5": "sha512-UoCo3Pynbm37aLEEoydSiG+t24ui7sLD40+07CKxzxNy4PpSowJMkvlLIiV67XjP1lMVynhQVnuwlTABqBH8LQ==",
  "@smithy/core@3.36.0": "sha512-3hJiwG1F5t1SoXqp/yOCmYXziyx7ZVqF63S5W6YU201e/qwVaHPex+E/3vvyY9a3ORq/b+BydeNZpP2saQ9X2g==",
  "@types/bun@1.4.3": "sha512-N67Pqy8JXbAY/j0tNraS3V5mubGvc6rrrNDmDCtZLlFzccbUJPDb0tvgUBC5q4m8ybkP93Jcn1QB+RYQ6PvBhw==",
  "@types/d3-zoom@3.0.9": "sha512-0sE1406XBYJGiqD3AusTl9ZqC//2mIXix51tbom25gDCA8ri4xnSZg28CaSE8Srl6FClqABUKfsn0qghgdepMA==",
  "@types/node@26.6.5": "sha512-uMzsv9stDdofIZBx4UGh4Z9ZgXnGC9seRDscilBcTHAeOFk67MZg/k9bWVfO+bk4qZmG+l52hRnLwUiH2LnJTg==",
  "@types/prop-types@15.7.15": "sha512-F6bEyamV9jKGAFBEmlQnesRPGOQqS2+Uwi0Em15xenOxHaf2hv6L8YCVn3rPdPJOiJfPiCnLIRyvwVaqMY3MIw==",
  "@types/react-dom@18.3.7": "sha512-MEe3UeoENYVFXzoXEWsvcpg6ZvlrFNlOQ7EOsvhI3CfAXwzPfO8Qwuxd40nepsYKqyyVQnTdEfv68q91yLcKrQ==",
  "@types/react@18.3.31": "sha512-vfEqpXTvwT91yhmwdfouStN2hSKwTvyRs8qpLfADyrq/kxDw0hZM7Wk9Ug1FELj8hIby+S/+kQCSRFF32nv2Qw==",
  "asn1js@3.1.0": "sha512-HWYi1THkOqguCiO+vwj09ZkQFD2kKEsejYHAYCtX0D80WVdoDnvRc9IukXX/jeb0T9NRWJnRtqwdbHltnFjwXA==",
  "bun-types@1.4.3": "sha512-tinRJNGOmUN+tEAsn2y2e942n9JHRHR42iUYzDH75NmhJqVBokGSQkkfSFdNWwsANIdrK6ACH9t01M452YyTwg==",
  "chromium-bidi@157.0.8090-0": "sha512-KJw7IQgqXwxpJgJlEIPg5mr2ZoqA+jkTRtc5EABI7sUJ3bu3cpI7NuEBoj4Gn1AsF78CaT9So5WQWspK3/wYag==",
  "content-disposition@2.0.1": "sha512-e+H0ZXHSWYrENhQzw1LPuP4oF5MzVKmDU6d3hxlvaPEYLLg62MxtQNPRx4SYSuYJSBUgnQIG4HIN2tEtNv7Dog==",
  "cytoscape@3.34.4": "sha512-msY99tMY8iWTg+sIPGfSqDcPNOt4xcj+v/K/7qUFaCUxxlqnMkUYLBjRUzn9W5CU/R2hrmtJa5+UtovrEM2ctg==",
  "devtools-protocol@0.0.1696802": "sha512-FO5/SENfvc2K8wRnWQflKcwuoTH4dBkXCWTQ9ebIWtuX8JM5+ZvCotaEmkfh21pO7TvIKGTM3hG4xFiq9WTwmg==",
  "dompurify@3.4.17": "sha512-B/pSlYVHQ58kqISD/yDjuJ1yfzI34m1gF4lAod2bwSRhiN4K5Cl3H8Af7hqB2PmTL911tdEudnnXn5FnhRoz0w==",
  "express-rate-limit@8.7.1": "sha512-2FXbqkygil3mZiXzEtM0IjE/UBmBNot0J1GEVrJT4JbrvwOSoEtqtO+wHbiMQELWe1eNvHoYRg2dkjOid+6JkA==",
  "express@5.3.0": "sha512-qCqy1xSoaugxOD4IVHb1ZWdkvCF2W3aE2okKouWj8VwJ+ztskSiXoBnCSJqfKT+cVPJhuJqe9YLbY425+Zh00g==",
  "get-east-asian-width@1.7.0": "sha512-XjH1AECxf0giL2V1aU8vKyRR2ppRUb5c0EvT7zuJTokQ74bNo52zOtghqdWIqrhUD79fo3x0WfKZdOqxF6LG1Q==",
  "hono@4.13.13": "sha512-CQ46U0ZkAGmbT/4UxdzzGJpacP2IeKgY4a5/tOI9AABbpOMfK739wfDXmv1usCk+3RkKj1hQy4/fjhiwa2xlrA==",
  "ignore@7.0.12": "sha512-/8UvqAPU9DGTI9k4mxtf49U37Isfwr8Uts96+SBHIkFxPJnHS0Ew4f00sM4Scd8V8EjM0jUNtVDdv1kPdt35lg==",
  "ip-address@10.7.4": "sha512-DWBMKyeM25D70nrIiTkgQth59/G+naKOTep6huF9j+GmeK3DMD60Zvxg5d5qQnz+38AHgou6ean2LECX+lrKDg==",
  "loose-envify@1.4.0": "sha512-lyuxPGr/Wfhrlem2CL/UcnUc1zcqKAImBDzukY7Y5F/yQiNdko6+fRLevlw1HgMySw7f611UIY408EtxRSoK3Q==",
  "marked@18.1.1": "sha512-zEGgrtUG8crk+TrMacJSVABU4DYDDkS8uqgU3ohrn/2fW9C2AEfUrO3m6IhpIpQpl7YcVpiXXC9cSMWDANT3dg==",
  "mdast-util-find-and-replace@3.0.3": "sha512-xPgpDNl0/OXHsI7TlaIs22lWnH3KlpvZdXG1ET/m/YT2Hhdkx8lJV4kLphE6l9simyM4KPDFBwas08BgEob6Jw==",
  "mdast-util-from-markdown@2.1.0": "sha512-KRLgmPaP2H1ul2bpoJkOS+9pAcDAAj9Nu1mqLnh8NLeJG5tlvj42TH80PIGBpROWlRXLk0lDrWNuZCFy/tsB4A==",
  "mdast-util-to-markdown@2.2.0": "sha512-2Jn/ADrHFFyyniBMi0bncTbJqU78K3/TEYvzvwrWWzD9MYPUa/Gm4r3nOeKFQg/PDM5BsbDYdc8ackW4NTY6NA==",
  "modern-tar@0.8.6": "sha512-LYSks0tNVqbtez/9OB0YFP6qLRSqkdAxJWOQpVaR67lNTbj2zNLyYpowkRMia5lXLCZKzxwoxkxH2MbbBR2aEg==",
  "package-manager-detector@1.9.0": "sha512-zAMfbta9nPA8AKkA4WdmNAT8R8s6Dk0/xwPsqNnRidMFcLo1YkLuPDTgs2f64XdzS8vbLNnoJ+uUIkgbz7oRHA==",
  "pdfjs-dist@6.4.299": "sha512-AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==",
  "puppeteer-core@25.14.0": "sha512-LQitnes3tBeVbdZ7V/4iwJPLZGgkl9uBVK0W7YYMh68j/3Y9eNuvj4yl+Fdo7zN0SuajOMrhd7aPj3DifK8k6A==",
  "qs@6.16.1": "sha512-5Px6J7rfHBAGUhNQ3es4YzcOdBBw0SDcVtThJml4RdnKw4tKs2epA0kPZ+K8X+WiHktT93RHVcQ/3ym5aTCgtg==",
  "react-dom@18.3.1": "sha512-5m4nQKp+rZRb09LNH59GM4BxTh9251/ylbKIbpe7TpGxfJ+9kv6BLkLBXIjjspbgbnIBNqlI23tRnTWT0snUIw==",
  "react-dom@19.3.1": "sha512-Y0bARz53lhEC1NMCASs0/j+faB/zqt3R8hpvg1e8+61ZVJ4UL0UdC4cBbXfZMcIuhrfgeILTLe+ZeBCavQPtKQ==",
  "react@18.3.1": "sha512-wS+hAgJShR0KhEvPJArfuPVN1+Hz1t0Y6n5jLrGQbkb4urgPE/0Rve+1kMB1v/oWgHgm4WIcV+i7F2pTVj+2iQ==",
  "react@19.3.1": "sha512-QNhWdt7nrgVWWQG58QuGsAR3jv3Hbe4mb4vz7w2csnHavciZJgda1CPNaldF6eVxv90ud3jUXpKlHL69gO38yw==",
  "scheduler@0.23.2": "sha512-UOShsPwz7NrMUqhR6t0hWjFduvOzbtv7toDH1/hIrfRNIDBnnBWd0CwJTGvTpngVlmwGCdP9/Zl/tVrDqcuYzQ==",
  "typed-query-selector@2.12.3": "sha512-/dtuMZyutHLlrxWhhC1uib00ELUr2dZ8C9B8YzZYsJmeE3V56OxRblrSM2UaF142pcMtak7ehZ6+poWGeehNIg==",
  "undici@7.30.1": "sha512-03KrMbjIFDWQR5RNPrSw3bd1r12JpyFQl9/yxjUbJtqkjmllqC5lFjZh6ujeuJCKr8EOQvRW872Oy/az+nLYxg==",
  "uuid@14.0.3": "sha512-Sc5u1VVln93y1Xnz4R+CunOZc7R9LUcTmhj7Rc7Eg3HVcf7rVn2FOoa812fe0W8p3jD7xeoGSYbfqCGGH2B6xw==",
  "webdriver-bidi-protocol@1.0.1": "sha512-WXWs/aXF2a6Al1Z2/V/7Gp2oPZOAAmHjJOTmv4KCXRJ122IMj3tSSMc6a4q3K4QOmhQbse/Ahr+oTVJOU2dUiw==",
  "yaml@2.9.1": "sha512-3NxN8+78OdzbT7C/WjGsyfPAtJaN3FNDsWxv7Y7mcDsT/oOmgW8BpyQQFFBnvZE3j9Y2Sdz1ULFLezL7Eb2yFw==",
  "zod@4.6.7": "sha512-g8W2D2kU6a8untc053fX1uVBKzM7yqAxW/3zwk83+6RyF2+SKOuV+c0wBDhUwzV1PaGapmZH+rmcUzPf+3CGwg=="
};
type Catalog = { version: 1; purpose: "offline-packed-consumer-cache"; packages: {name: string; version: string; integrity: string; tarball: string}[] };
export function offlinePackInstallArgs(argv: readonly string[], bun: string, cwd: string, packages: readonly string[]): string[] | undefined {
  if (argv[0] !== bun || argv[1] !== "add") return;
  const main = cwd === "/consumer-work/pack-work/brainkit-consumer", react18 = cwd === "/consumer-work/pack-work/brainkit-react18-consumer";
  if (!main && !react18) throw new Error("Unexpected packed installer location");
  const specs = argv.slice(2), tarballs = specs.filter(value => value.endsWith(".tgz"));
  for (const path of tarballs) {
    assert(/^\/consumer-work\/pack-work\/brainkit-tarballs\/[a-z0-9-]+\.tgz$/.test(path), "CI_BUILD_PACK_TARBALL_LOCATION");
    assert(packages.includes(path.split("/").at(-1)!.slice(0, -4)), "CI_BUILD_PACK_TARBALL_PACKAGE");
  }
  const other = specs.filter(value => !value.endsWith(".tgz"));
  const allowed = main ? [["react", "react-dom"], ["-d", "@types/bun", "@types/react", "@types/react-dom"]] : [["react@^18", "react-dom@^18"], ["-d", "@types/react@^18", "@types/react-dom@^18"]];
  assert(allowed.some(expected => identity(expected) === identity(other)), "CI_BUILD_ONLY_KNOWN_PACK_INSTALLERS");
  if (other[0] === "-d") assert.equal(tarballs.length, 0); else assert(tarballs.length > 0);
  return [bun, "add", "--offline", "--ignore-scripts", "--backend=copyfile", "--cache-dir=/consumer-work/cache", ...specs];
}
export function prepareBuildConsumers(root: string, directory: string) {
  const supplied = join(root, "tmp/ci-build-consumer-cache");
  if (!existsSync(join(supplied, "catalog.json"))) throw new Error("Missing verified offline packed-consumer cache; no acquisition is permitted");
  const catalog = JSON.parse(buildRead(join(supplied, "catalog.json"), undefined, 4 * 1024 * 1024).bytes.toString("utf8")) as Catalog;
  assert.equal(catalog.version, 1); assert.equal(catalog.purpose, "offline-packed-consumer-cache"); assert(Array.isArray(catalog.packages) && catalog.packages.length > 0);
  const lock = ts.parseConfigFileTextToJson("bun.lock", buildRead(join(root, "bun.lock")).bytes.toString("utf8")); assert(!lock.error);
  const locked = new Map<string, string>();
  for (const entry of Object.values(lock.config.packages ?? {}) as any[]) if (Array.isArray(entry) && typeof entry[0] === "string") {
    const integrity = entry.findLast(value => typeof value === "string" && value.startsWith("sha512-")); if (integrity) locked.set(entry[0], integrity);
  }
  const destination = join(directory, "consumer-input"); mkdirSync(destination, { mode: 0o700 }); mkdirSync(join(destination, "tarballs"), { mode: 0o700 });
  for (const pkg of catalog.packages) {
    assert(/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(pkg.name) && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-z0-9.-]+)?$/i.test(pkg.version));
    const expected = locked.get(`${pkg.name}@${pkg.version}`) ?? extraConsumerIntegrities[`${pkg.name}@${pkg.version}`];
    assert(expected && expected === pkg.integrity, "CI_BUILD_CONSUMER_TARBALL_HAS_REVIEWED_INTEGRITY");
    assert(/^tarballs\/[0-9a-f]{64}\.tgz$/.test(pkg.tarball));
    const bytes = buildRead(join(supplied, pkg.tarball)).bytes;
    assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, expected);
    writeFileSync(join(destination, pkg.tarball), bytes, { flag: "wx", mode: 0o600 });
  }
  const records = captureOutputs(join(supplied, "cache"), join(destination, "cache"));
  writeFileSync(join(destination, "catalog.json"), JSON.stringify(catalog), { flag: "wx", mode: 0o600 });
  return { source: destination, identity: identity({ records, catalog }), catalog };
}
/** Data-only archive structure; the raw tarball SRI is checked separately. */
export function consumerArchiveRoot(names: readonly string[]): string {
  assert(names.length > 0 && names.every(name => !/[\x00-\x1f\x7f\\]/.test(name) && !posix.isAbsolute(name) && !name.split("/").includes("..")), "CI_BUILD_PACK_ARCHIVE_PATHS");
  // npm's fixed verified artifacts include harmless ./ header components.
  // They remain beneath one root; symbolic/hard aliases are refused separately.
  const canonical = names.map(name => posix.normalize(name).replace(/\/$/, ""));
  const roots = new Set(canonical.map(name => name.split("/")[0]));
  assert.equal(roots.size, 1, "CI_BUILD_PACK_SINGLE_ARCHIVE_ROOT");
  const root = [...roots][0]!; assert(root && root !== "." && canonical.includes(`${root}/package.json`), "CI_BUILD_PACK_ROOT_MANIFEST");
  return root;
}
export function checkConsumerArchiveIdentity(text: string, name: string, version: string): void {
  const manifest = JSON.parse(text);
  assert(manifest.name === name && manifest.version === version, "CI_BUILD_PACK_ARCHIVE_IDENTITY_MATCHES_CATALOG");
}
/** Fixed consumer archive inspection; no extraction or caller-selected executor. */
export async function inspectConsumerArchive(bytes: Uint8Array, name: string, version: string): Promise<Map<string, string>> {
  // Measured catalog maxima: 285,794,117 expanded bytes, 285,793,528 entry
  // bytes and 4,255 entries. Keep explicit headroom without unbounded payloads.
  assert(bytes.byteLength <= 256 * 1024 * 1024, "CI_BUILD_PACK_COMPRESSED_ARCHIVE_BOUND");
  const { createTarDecoder } = await import("modern-tar");
  const stream = new Blob([Uint8Array.from(bytes)]).stream().pipeThrough(new DecompressionStream("gzip")).pipeThrough(createTarDecoder({ strict: true }));
  const entries = new Map<string, {type: string; mode: number; size: number; sha256: string}>(), names: string[] = [];
  let count = 0, expanded = 0, manifest: string | undefined;
  for await (const entry of stream) {
    assert(++count <= 8192, "CI_BUILD_PACK_ARCHIVE_ENTRY_COUNT_BOUND");
    const header = entry.header;
    assert(header.type === "file" || header.type === "directory", "CI_BUILD_PACK_ARCHIVE_REGULAR_ONLY");
    assert(typeof header.mode === "number" && Number.isInteger(header.mode) && header.mode >= 0 && header.mode <= 0o177777 && ((header.mode & 0o170000) === 0 || (header.mode & 0o170000) === (header.type === "file" ? 0o100000 : 0o040000)), "CI_BUILD_PACK_ARCHIVE_MODE");
    assert(header.size <= 320 * 1024 * 1024 && header.size >= 0 && (header.type !== "directory" || header.size === 0), "CI_BUILD_PACK_ARCHIVE_ENTRY_BYTES_BOUND");
    names.push(header.name);
    assert(!/[\x00-\x1f\x7f\\]/.test(header.name) && !posix.isAbsolute(header.name) && !header.name.split("/").includes(".."), "CI_BUILD_PACK_ARCHIVE_PATHS");
    const path = posix.normalize(header.name).replace(/\/$/, ""), rootManifest = path.split("/").length === 2 && path.endsWith("/package.json");
    const hash = createHash("sha256"), chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of entry.body) {
      size += chunk.byteLength; expanded += chunk.byteLength;
      assert(size <= header.size && expanded <= 384 * 1024 * 1024, "CI_BUILD_PACK_ARCHIVE_EXPANDED_BYTES_BOUND");
      hash.update(chunk); if (rootManifest) { assert(size <= 2 * 1024 * 1024, "CI_BUILD_PACK_ROOT_MANIFEST_BOUND"); chunks.push(chunk); }
    }
    assert.equal(size, header.size, "CI_BUILD_PACK_ARCHIVE_EXACT_ENTRY_SIZE");
    const actual = {type: header.type, mode: header.mode, size, sha256: hash.digest("hex")}, prior = entries.get(path);
    if (prior) assert.deepEqual(actual, prior, "CI_BUILD_PACK_CANONICAL_DUPLICATE_IDENTICAL"); else entries.set(path, actual);
    if (rootManifest) manifest = Buffer.concat(chunks).toString("utf8");
  }
  const root = consumerArchiveRoot(names); assert(manifest !== undefined, "CI_BUILD_PACK_ROOT_MANIFEST"); checkConsumerArchiveIdentity(manifest, name, version);
  const files = new Map<string, string>();
  for (const [path, entry] of [...entries].sort(([a],[b])=>a.localeCompare(b))) {
    assert(path.startsWith(`${root}/`) || path === root && entry.type === "directory", "CI_BUILD_PACK_ENTRY_BENEATH_ROOT");
    if (entry.type === "file") files.set(path.slice(root.length + 1), entry.sha256);
  }
  return files;
}
/** Necessary physical-payload verification for the supported hoisted layout.
 * Isolated hidden stores, package aliases, payload links and unknown sidecars
 * are explicitly unsupported. This does not flatten or rewrite dependencies.
 */
export function verifyConsumerTree(modules: string, archives: ReadonlyMap<string, ReadonlyMap<string, string>>) {
  const payloads: {name: string; version: string; identity: string; directory: string}[] = [];
  const verified = new Set<string>(), bins: {name: string; path: string}[] = [], declaredBins = new Map<string, Set<string>>();
  assert(lstatSync(modules).isDirectory(), "CI_BUILD_PACK_MODULES_ROOT_PHYSICAL");
  const root = realpathSync(modules); assert.equal(root, modules, "CI_BUILD_PACK_MODULES_ROOT_CANONICAL");
  const scanModules = (directory: string) => {
    assert(lstatSync(directory).isDirectory(), "CI_BUILD_PACK_MODULES_PHYSICAL_DIRECTORY");
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path);
      if (name === ".bin") {
        assert(stat.isDirectory(), "CI_BUILD_PACK_BIN_DIRECTORY_PHYSICAL");
        for (const bin of readdirSync(path).sort()) {
          const file = join(path, bin); assert(lstatSync(file).isSymbolicLink(), "CI_BUILD_PACK_BIN_ALIAS_ONLY");
          assert(!readlinkSync(file).startsWith("/"), "CI_BUILD_PACK_BIN_ALIAS_RELATIVE");
          bins.push({name: bin, path: realpathSync(file)});
        }
        continue;
      }
      assert(!name.startsWith("."), "CI_BUILD_PACK_HIDDEN_INSTALL_LAYOUT_UNSUPPORTED");
      if (name.startsWith("@")) {
        assert(stat.isDirectory(), "CI_BUILD_PACK_SCOPE_PHYSICAL");
        for (const child of readdirSync(path).sort()) { assert(!child.startsWith("."), "CI_BUILD_PACK_HIDDEN_SCOPE_UNSUPPORTED"); scanPackage(join(path, child)); }
      } else scanPackage(path);
    }
  };
  const scanPackage = (directory: string) => {
    assert(lstatSync(directory).isDirectory(), "CI_BUILD_PACK_PACKAGE_ALIAS_UNSUPPORTED");
    const manifest = JSON.parse(buildRead(join(directory, "package.json")).bytes.toString("utf8"));
    const expected = archives.get(`${manifest.name}@${manifest.version}`);
    assert(expected, "CI_BUILD_PACK_DEPENDENCY_IS_REVIEWED");
    const bundled = [...expected.keys()].some(path => path.startsWith("node_modules/"));
    const actual = new Map<string, string>();
    const walk = (base: string, prefix = "") => {
      for (const name of readdirSync(base).sort()) {
        const file = join(base, name), path = prefix ? `${prefix}/${name}` : name, stat = lstatSync(file);
        // Only an unbundled package-root dependency tree is separate from its
        // archive. Every vendor/.../node_modules and bundled byte stays in it.
        if (!prefix && name === "node_modules" && !bundled) { scanModules(file); continue; }
        if (stat.isDirectory()) walk(file, path);
        else {
          assert(stat.isFile(), "CI_BUILD_PACK_INSTALLED_PAYLOAD_REGULAR");
          actual.set(path, createHash("sha256").update(buildRead(file).bytes).digest("hex")); verified.add(file);
        }
      }
    };
    walk(directory);
    assert.deepEqual([...actual].sort(([a],[b])=>a.localeCompare(b)), [...expected].sort(([a],[b])=>a.localeCompare(b)), "CI_BUILD_PACK_CACHE_PAYLOAD_MATCHES_VERIFIED_TARBALL");
    const commands = typeof manifest.bin === "string" ? { [manifest.name.split("/").at(-1)]: manifest.bin } : manifest.bin ?? {};
    for (const [name, target] of Object.entries(commands)) {
      assert(typeof target === "string" && !posix.isAbsolute(target) && !target.includes("\\") && !posix.normalize(target).startsWith("../"), "CI_BUILD_PACK_BIN_DECLARATION_LOCAL");
      const file = join(directory, target); assert(verified.has(file), "CI_BUILD_PACK_BIN_PAYLOAD_VERIFIED");
      const targets = declaredBins.get(name) ?? new Set<string>(); targets.add(file); declaredBins.set(name, targets);
    }
    payloads.push({name: manifest.name, version: manifest.version, identity: identity([...actual].sort(([a],[b])=>a.localeCompare(b))), directory: relative(root,directory)});
  };
  scanModules(root);
  for (const bin of bins) assert(verified.has(bin.path) && declaredBins.get(bin.name)?.has(bin.path), "CI_BUILD_PACK_BIN_TARGET_IS_VERIFIED_DECLARED_PAYLOAD");
  return payloads;
}
/** Called only inside the fixed image, before any installed consumer imports. */
export async function runBuildConsumers(packages: string[]) {
  const { ciPack } = await import("./ci-pack");
  const catalog = JSON.parse(buildRead("/consumer-input/catalog.json", undefined, 4 * 1024 * 1024).bytes.toString("utf8")) as Catalog;
  // Consumer-only bulk/cache/extraction bytes use the owned disk-backed
  // diagnostics child bound outside /repo, so imports cannot climb into the
  // captured installation. Production tmpfs and bounds stay unchanged.
  cpSync("/consumer-input/cache", "/consumer-work/cache", { recursive: true, dereference: false });
  mkdirSync("/consumer-work/temp", { mode: 0o700 });
  process.env.TMPDIR = "/consumer-work/temp";
  const work = "/consumer-work/pack-work"; mkdirSync(work, { mode: 0o700 });
  // Bun's authoritative pack/pin probes temporarily rewrite package manifests
  // and node_modules/.pin-probe.tgz. Give those probes a physical private
  // copy, while keeping /repo immutable and consumer ancestry separate.
  const repository = "/consumer-work/repository"; mkdirSync(repository, { mode: 0o700 });
  for (const name of readdirSync("/repo")) if (name !== "tmp") cpSync(join("/repo", name), join(repository, name), { recursive: true, dereference: false });
  const transport = Bun as unknown as { spawn: (...args: any[]) => any }, original = transport.spawn;
  const installers: {original: string[]; actual: string[]; cwd: string; nativeBinlink: "disabled"; code?: number}[] = [];
  const verifiedArchives = new Map<string, Map<string, string>>();
  const { listPublishablePackages } = await import("./publishable-packages");
  const firstParty = listPublishablePackages("/repo");
  const archiveFiles = async (archive: string, name: string, version: string) => {
    const cacheKey = `${archive}\0${name}@${version}`;
    if (verifiedArchives.has(cacheKey)) return verifiedArchives.get(cacheKey)!;
    const files = await inspectConsumerArchive(buildRead(archive, undefined, 256 * 1024 * 1024).bytes, name, version);
    verifiedArchives.set(cacheKey, files); return files;
  };
  const actualPayloads: {name: string; version: string; identity: string; directory: string}[] = [];
  const verifyInstalled = async (cwd: string) => {
    // Every physical installed package is checked before ciPack can import.
    // Unknown hidden stores/aliases are unsupported, never version-only proof.
    const archives = new Map<string, ReadonlyMap<string, string>>();
    for (const pkg of firstParty) archives.set(`${pkg.manifest.name}@${pkg.manifest.version}`, await archiveFiles(join(work, "brainkit-tarballs", `${pkg.dir}.tgz`), pkg.manifest.name, pkg.manifest.version));
    for (const pkg of catalog.packages) archives.set(`${pkg.name}@${pkg.version}`, await archiveFiles(`/consumer-input/${pkg.tarball}`, pkg.name, pkg.version));
    actualPayloads.push(...verifyConsumerTree(join(cwd, "node_modules"), archives));
  };
  transport.spawn = (...args: any[]) => {
    if (!Array.isArray(args[0])) return original(...args);
    const actual = offlinePackInstallArgs(args[0], process.execPath, args[1]?.cwd ?? "", packages);
    if (!actual) return original(...args);
    const observation = { original: [...args[0]], actual, cwd: args[1].cwd, nativeBinlink: "disabled" as const, code: undefined as number | undefined }; installers.push(observation);
    // The exact pinned Bun otherwise redirects esbuild's .bin alias into an
    // optional native package without its own bin declaration. Keep the same
    // graph/payloads and the declared wrapper so the strict alias guard holds.
    const child = original(actual, { ...args[1], env: { ...args[1].env, BUN_FEATURE_FLAG_DISABLE_NATIVE_DEPENDENCY_LINKER: "1" } });
    const exited = child.exited.then(async (code: number) => { observation.code = code; if (code === 0) await verifyInstalled(args[1].cwd); return code; });
    return new Proxy(child, { get(target, key) { if (key === "exited") return exited; const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; } });
  };
  try {
    const node = original(["/usr/bin/node", "-p", "process.versions.node"], { stdout: "pipe", stderr: "pipe" });
    const [version, code] = await Promise.all([new Response(node.stdout).text(), node.exited]); assert.equal(code, 0); assert(Bun.semver.satisfies(version.trim(), ">=24.0.0"), "CI_BUILD_PACK_NODE_MATCHES_CI");
    await ciPack(repository, work);
    assert.equal(installers.length, 4, "CI_BUILD_ALL_PACK_INSTALLERS_OFFLINE"); assert(installers.every(child => child.code === 0));
    return { version: 1, purpose: "qualification-consumers", authority: "none", completed: true, packages, node: version.trim(), installers, actualPayloads, registryAcquisition: "disabled-by-offline-native-installer-and-network-namespace" };
  } finally { transport.spawn = original; }
}
