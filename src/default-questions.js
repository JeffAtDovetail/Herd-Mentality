// Default question set. Edit these from the host screen ("Edit questions") before
// starting a game; edits are saved to data/questions.json.
//
// type: 'choice' -> players tap one of `options` (any number of options)
// type: 'text'   -> players type a free-text answer, matched with fuzzy text matching

export const DEFAULT_SETTINGS = {
  choiceSeconds: 15, // timer for multiple-choice questions
  textSeconds: 20, // timer for free-text questions (typing takes longer)
};

export const DEFAULT_QUESTIONS = [
  // --- Multiple choice ------------------------------------------------------
  {
    type: 'choice',
    text: 'Cats or dogs?',
    options: ['Cats', 'Dogs', 'No pets'],
  },
  {
    type: 'choice',
    text: 'Best pizza topping',
    options: ['Pepperoni', 'Margherita', 'Hawaiian', 'Mushroom', 'Meat lovers', 'BBQ chicken'],
  },
  {
    type: 'choice',
    text: 'Favourite physical activity',
    options: ['Running', 'Tennis', 'Basketball', 'Soccer / Football', 'Swimming', 'Gym', 'Yoga / Pilates', 'Cycling'],
  },
  {
    type: 'choice',
    text: 'Best decade for music',
    options: ['70s', '80s', '90s', '2000s', '2010s'],
  },
  {
    type: 'choice',
    text: 'Favourite meat',
    options: ['Chicken', 'Beef', 'Pork', 'Lamb', 'Seafood', 'None — I’m veggie'],
  },
  {
    type: 'choice',
    text: 'Dream holiday',
    options: ['Beach', 'Mountains', 'City break'],
  },
  {
    type: 'choice',
    text: 'Favourite time of the day',
    options: ['Sunrise', 'Morning', 'Afternoon', 'Evening', 'Sunset', 'Midnight'],
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

  // --- Free text ------------------------------------------------------------
  {
    type: 'text',
    text: 'Name a breakfast food',
  },
  {
    type: 'text',
    text: 'Name a country you’d love to travel to',
  },
  {
    type: 'text',
    text: 'Favourite room in a house',
  },
  {
    type: 'text',
    text: 'Most well known person',
  },
];
