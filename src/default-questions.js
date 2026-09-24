// Default question set. Edit these from the host screen ("Edit questions") before
// starting a game; edits are saved to data/questions.json.
//
// type: 'choice' -> players tap one of `options` (any number of options)
// type: 'text'   -> players type a free-text answer, matched with fuzzy text matching

export const DEFAULT_SETTINGS = {
  secondsPerQuestion: 20,
};

export const DEFAULT_QUESTIONS = [
  {
    type: 'choice',
    text: 'Cats or dogs?',
    options: ['Cats', 'Dogs', 'Neither'],
  },
  {
    type: 'text',
    text: 'Name a breakfast food',
  },
  {
    type: 'text',
    text: 'Name a country you’d love to travel to',
  },
  {
    type: 'choice',
    text: 'Best sport to watch live',
    options: ['Rugby league', 'AFL', 'Cricket', 'Football (soccer)', 'Tennis', 'Basketball'],
  },
  {
    type: 'text',
    text: 'Name a musical instrument',
  },
  {
    type: 'choice',
    text: 'What is the favourite Dovetail value?',
    options: [
      'Put the customer first',
      'If we do it, we nail it',
      'Stay humble',
      'Do the thing',
      'Open by default',
    ],
  },
  {
    type: 'text',
    text: 'Name a famous wizard',
  },
  {
    type: 'choice',
    text: 'Best meeting room',
    options: [
      'Paramount',
      'City Edge',
      'Starbucks',
      'York Lane',
      'Shakey',
      'Dougie',
      'Ichiran',
      'Messina',
      'Marketing Space',
      'Design Space',
      'Lounge',
      'Roof',
      'Darktales',
      'Flour & Stone',
      'Lucky Pickle',
      'Boiler Room',
      'Wildflower',
    ],
  },
];
