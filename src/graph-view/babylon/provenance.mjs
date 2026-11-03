// Source lineage only; no release, permission or acceptance authority.
export const sourceProvenance = Object.freeze({
  "description": "Local additive portable extraction; distribution and host integration remain separate receiving gates.",
  "controllerBaseline": "42ae72a5b161389ca0652eae3294ae643d26b1d6",
  "privateConsumerBaseline": "562f1e3fa880492b3e5c941c011adfd7c21b0370",
  "correctedConsumerSource": "e4fe5117d5545271b68cb7113e5cd0e10b31cf09",
  "graphViewProducer": "c5d787330692b664d37f7c5bca7e03f6b37f3d41",
  "portableChanges": [
    "Consumer imports point to the received graph-view helpers and sibling retained modules.",
    "Index provides internal opt-in entry; no package root export or mandatory Babylon dependency.",
    "Tests and invented fixture moved into dedicated consumer paths."
  ],
  "authorityLimit": "This record describes source lineage only; it is not a review verdict, grant, canonical admission, release or host acceptance.",
  "retainedModules": [
    {
      "module": "scene-controller.mjs",
      "sha256": "721f151beb9912235524ceba658c3654fde1da4cda0af2624f8d35a5518963d2",
      "changes": [],
      "extractedSha256": "721f151beb9912235524ceba658c3654fde1da4cda0af2624f8d35a5518963d2"
    },
    {
      "module": "semantic-picking.mjs",
      "sha256": "3577fa576b1074051c4c2c2aa94ccccb4dd0fb4b18293d70751497ced4ba8e6b",
      "changes": [],
      "extractedSha256": "3577fa576b1074051c4c2c2aa94ccccb4dd0fb4b18293d70751497ced4ba8e6b"
    },
    {
      "module": "babylon-scene-port.mjs",
      "sha256": "335cb8681ed584f51f6e1a8fa97cb36450a32ce197afaa58b8d05372b4537e07",
      "changes": [
        "Adapter-local generated mesh and material labels normalized to neutral generic names; identity and geometry behavior unchanged."
      ],
      "extractedSha256": "683f703b09c35ac0935a4ffa7bb00cf819eacb2351c99821215bfd27a222d0ee"
    }
  ]
})
