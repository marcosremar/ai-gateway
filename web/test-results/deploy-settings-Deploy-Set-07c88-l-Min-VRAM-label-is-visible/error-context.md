# Page snapshot

```yaml
- generic [active]:
  - img [ref=e3]
  - alert [ref=e6]
  - dialog "Server Error" [ref=e9]:
    - generic [ref=e10]:
      - generic [ref=e11]:
        - navigation [ref=e13]:
          - button "previous" [disabled] [ref=e14]:
            - img "previous" [ref=e15]
          - button "next" [disabled] [ref=e17]:
            - img "next" [ref=e18]
          - generic [ref=e20]: 1 of 1 error
          - generic [ref=e21]:
            - text: Next.js (14.2.35) is outdated
            - link "(learn more)" [ref=e23] [cursor=pointer]:
              - /url: https://nextjs.org/docs/messages/version-staleness
        - heading "Server Error" [level=1] [ref=e24]
        - paragraph [ref=e25]: "TypeError: e[o] is not a function"
        - generic [ref=e26]: This error happened while generating the page. Any console logs will be displayed in the terminal window.
      - generic [ref=e27]:
        - heading "Call Stack" [level=2] [ref=e28]
        - group [ref=e29]:
          - generic "Next.js" [ref=e30] [cursor=pointer]:
            - img [ref=e31]
            - img [ref=e33]
            - text: Next.js
        - generic [ref=e38]:
          - heading "JSON.parse" [level=3] [ref=e39]
          - generic [ref=e41]: <anonymous>
        - group [ref=e42]:
          - generic "Next.js" [ref=e43] [cursor=pointer]:
            - img [ref=e44]
            - img [ref=e46]
            - text: Next.js
```