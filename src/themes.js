// Night Shift themes: every word the game says lives here, one block per theme.
// Shared by the room server (worker), the simulator and the page.
//
// Internally the four roles are always 'mafia', 'doctor', 'police' and 'citizen',
// and the two sides are 'mafia' and 'town'. A theme only renames and re-words them.
//
//   roles.X.name   what the card says (singular)
//   roles.X.group  how the narrator addresses them ("Mafia, open your eyes")
//   roles.X.plural used in counts ("2 Citizens")
//

function englishText(R) {
  const M = R.mafia.group, D = R.doctor.group, P = R.police.group;
  return {
    night: 'Night', day: 'Day', morning: 'Morning', crew: 'Your crew', alone: 'Just you. Work alone.',
    lines: {
      kill: `Everyone, close your eyes. ${M}, open your eyes and choose someone.`,
      save: `${M}, close your eyes. ${D}, open your eyes. Who do you want to save?`,
      check: `${D}, close your eyes. ${P}, open your eyes. Who do you want to check?`,
      dawn: `${P}, close your eyes. Everyone, open your eyes.`,
      trial: 'Talk it over, then vote. Who goes on trial?',
      trialOpening: 'Good morning, everyone. Look around, talk it over, then vote. Who goes on trial?',
    },
    dawnQuiet: 'A quiet night. Nobody was attacked.',
    dawnOut: (n) => `${n} was attacked and is out.`,
    dawnSaved: (n) => `${n} was attacked but saved.`,
    isBad: (n) => `${n} is ${R.mafia.name}`,
    isNotBad: (n) => `${n} is not ${R.mafia.name}`,
  };
}

function theme(def) {
  return { ...def, text: { ...englishText(def.roles), ...(def.text || {}) } };
}

export const THEMES = {
  city: theme({
    key: 'city',
    name: 'The City',
    game: 'Mafia',
    tagline: 'A quiet city after dark. Somebody on the night shift is up to no good.',
    roles: {
      mafia: { name: 'Mafia', group: 'Mafia', plural: 'Mafia',
        blurb: 'Each night, you and your crew quietly choose someone to take off the streets. By day, blend in.' },
      doctor: { name: 'Doctor', group: 'Doctor', plural: 'Doctors',
        blurb: 'Each night, choose one person to protect. You can protect yourself, but not the same person two nights running.' },
      police: { name: 'Detective', group: 'Detective', plural: 'Detectives',
        blurb: 'Each night, investigate one person. Your card tells you whether they are Mafia.' },
      citizen: { name: 'Citizen', group: 'Citizens', plural: 'Citizens',
        blurb: 'No night job. Listen closely, argue well, and vote the Mafia out.' },
    },
    teams: { mafia: { name: 'Mafia', win: 'Mafia win' }, town: { name: 'Citizens', win: 'Citizens win' } },
    // The card a player sees once they're out: one for a night kill, one for being voted out by day.
    out: { night: { title: 'Killed', icon: 'gun' }, day: { title: 'Run out of town', icon: 'case' } },
  }),

  // The full game has two more settings, The Woods (Werewolf) and The Metro (Chor Police, in Bengali).
  // They are not published in this showcase.
};

export const THEME_ORDER = ['city'];
export const ROLE_ORDER = ['mafia', 'doctor', 'police', 'citizen'];

export function themeOf(key) {
  return THEMES[key] || THEMES.city;
}
