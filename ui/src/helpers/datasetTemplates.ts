const datasetTemplates: { [key: string]: string } = {
  krea2_identity: `A portrait of [trigger] person.`,
  krea2_character: `An illustration of [trigger] character.`,
  ideogram4: `
{
  "high_level_description": "",
  "style_description": {
    "aesthetics": "",
    "lighting": "",
    "photo": "",
    "medium": "",
    "color_palette": []
  },
  "compositional_deconstruction": {
    "background": "",
    "elements": [
    ]
  }
}
`,
};

export default datasetTemplates;
