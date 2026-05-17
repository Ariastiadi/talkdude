// === Suggestion Chips ===
// Each entry: [icon, label]. 4 are picked at random per session.

export const SUGGESTIONS: [icon: string, label: string][] = [
  // Coding
  ["code", "Help me code"],
  ["code_blocks", "Debug my code"],
  ["terminal", "Write a script"],
  ["integration_instructions", "Review my code"],
  ["data_object", "Explain an algorithm"],
  ["api", "Design an API"],
  ["memory", "Optimize performance"],
  ["security", "Find security issues"],
  ["storage", "Design a database schema"],
  ["deployed_code", "Set up a project structure"],
  // Writing
  ["edit_note", "Write something"],
  ["article", "Draft an email"],
  ["text_ad", "Improve my writing"],
  ["description", "Summarize a document"],
  ["contract_edit", "Help me proofread"],
  ["format_quote", "Write a speech"],
  ["feed", "Draft a blog post"],
  ["mail", "Write a cover letter"],
  ["rate_review", "Write a review"],
  ["book", "Help outline a book"],
  // Learning
  ["school", "Explain a topic"],
  ["menu_book", "Teach me something new"],
  ["quiz", "Quiz me on a subject"],
  ["history_edu", "Tell me a fun fact"],
  ["science", "How does this work?"],
  ["fitness_center", "Give me a challenge"],
  ["bolt", "Explain it simply"],
  ["experiment", "Deep dive a topic"],
  ["language", "Learn about a culture"],
  ["calculate", "Walk me through the math"],
  // Creative
  ["lightbulb", "Brainstorm ideas"],
  ["draw", "Help me design"],
  ["palette", "Get creative"],
  ["auto_stories", "Tell me a story"],
  ["music_note", "Write some lyrics"],
  ["movie", "Write a scene"],
  ["photo_camera", "Describe a scene vividly"],
  ["tips_and_updates", "Give me a creative prompt"],
  ["face", "Create a character"],
  ["edit", "Write a poem"],
  // Productivity
  ["checklist", "Plan my day"],
  ["task_alt", "Organize my thoughts"],
  ["event_note", "Prepare for a meeting"],
  ["translate", "Translate something"],
  ["summarize", "Summarize this for me"],
  ["timer", "Help me prioritize"],
  ["folder", "Create a template"],
  ["note_alt", "Take notes with me"],
  ["calendar_month", "Plan a project timeline"],
  ["done_all", "Build a checklist"],
  // Problem solving
  ["psychology", "Think through a problem"],
  ["troubleshoot", "Help me decide"],
  ["explore", "Compare my options"],
  ["rocket_launch", "Start a new project"],
  ["build", "Build something cool"],
  ["balance", "Weigh pros and cons"],
  ["compare_arrows", "Find the best approach"],
  ["route", "Map out a plan"],
  ["hub", "Break it down for me"],
  ["search", "Diagnose the issue"],
  // Research & analysis
  ["manage_search", "Research a topic"],
  ["bar_chart", "Analyze this data"],
  ["fact_check", "Fact-check something"],
  ["trending_up", "Find the trend"],
  ["compare", "Compare two things"],
  ["biotech", "Explain the science"],
  ["history", "Give me the history"],
  ["public", "Explain current events"],
  // Career & personal
  ["work", "Prepare for an interview"],
  ["badge", "Help with my resume"],
  ["handshake", "Give me feedback"],
  ["groups", "Handle a tough conversation"],
  ["self_improvement", "Help me grow"],
  ["emoji_people", "Advice on a situation"],
  ["record_voice_over", "Practice a pitch"],
  ["volunteer_activism", "Help me communicate better"],
  // Fun & entertainment
  ["sports_esports", "Give me a game idea"],
  ["celebration", "Plan something fun"],
  ["restaurant", "Recommend a recipe"],
  ["travel_explore", "Plan a trip"],
  ["question_mark", "Hit me with trivia"],
  ["theaters", "Recommend something to watch"],
  ["headphones", "Discover new music"],
  ["stars", "Tell me something fascinating"],
];

// === Greeting Context Groups ===
// Groups pair tonally consistent greetings and subtitles. The picker selects
// a random group from the time-of-day pool, then one greeting and one subtitle
// from that group. This prevents tonal mismatches.

export interface ContextGroup {
  greetings: string[];
  subtitles: string[];
}

export const MORNING_GROUPS: ContextGroup[] = [
  {
    // Energetic: high-energy start, action-oriented subtitle
    greetings: [
      "Rise and shine",
      "Up and at 'em",
      "Morning, go-getter",
      "Let's crush it today",
      "Wakey wakey, time to make things happen",
      "Morning, champion",
      "Early bird mode activated",
      "Good morning, superstar",
      "Let's hit the ground running",
      "Morning energy engaged",
    ],
    subtitles: [
      "Ready to take on the day?",
      "What are we conquering first?",
      "Where do we start today?",
      "Big plans today?",
      "What's the first order of business?",
      "Let's make today count",
      "What's first on the agenda?",
      "Let's get after it",
    ],
  },
  {
    // Gentle: calm, unhurried tone on both sides
    greetings: [
      "Good morning",
      "Morning",
      "A new day, a fresh start",
      "Bright and early",
      "Peaceful morning",
      "A quiet start to the day",
      "Hello, new day",
      "Morning has arrived",
      "Gently does it this morning",
    ],
    subtitles: [
      "How can I help you today?",
      "What's on your mind?",
      "No rush, what's first?",
      "Take your time, I'm here",
      "What would you like to work on?",
      "Where shall we start?",
      "What's on the agenda?",
      "I'm here whenever you're ready",
    ],
  },
  {
    // Optimistic: uplifting greeting paired with exploratory subtitle
    greetings: [
      "Hello, sunshine",
      "A new day awaits",
      "Top of the morning",
      "Fresh start today",
      "Dawn of something great",
      "Here's to a great morning",
      "A brand new day begins",
      "The morning is yours",
      "Another chance to do great things",
      "The day is full of possibilities",
    ],
    subtitles: [
      "What are we making happen today?",
      "Where shall we begin?",
      "Something exciting on your mind?",
      "Let's make something happen",
      "What's the adventure today?",
      "What are we building today?",
      "What inspires you this morning?",
      "What would you like to explore?",
    ],
  },
];

export const AFTERNOON_GROUPS: ContextGroup[] = [
  {
    // Focused: mid-work check-in, momentum-keeping subtitle
    greetings: [
      "Good afternoon",
      "Afternoon",
      "Still at it?",
      "Making progress?",
      "Midday momentum",
      "Deep in the zone?",
      "Afternoon focus mode",
      "Back to it?",
      "Afternoon grind",
      "Keeping the engine running",
    ],
    subtitles: [
      "What are we working on?",
      "Let's keep the momentum going",
      "What needs solving?",
      "Where were we?",
      "What's next on the list?",
      "What's the current challenge?",
      "Let's make progress",
      "Back at it?",
    ],
  },
  {
    // Casual: low-key greeting, relaxed subtitle
    greetings: [
      "Hey there",
      "What's up?",
      "Hello",
      "Hey",
      "How's it going?",
      "Afternoon, friend",
      "Hey, good to see you",
      "What's happening?",
    ],
    subtitles: [
      "What's on your mind?",
      "Got a question?",
      "What can I do for you?",
      "Fire away",
      "What are you thinking about?",
      "I'm all ears",
      "Lay it on me",
      "Ask me anything",
    ],
  },
  {
    // Encouraging: supportive greeting, helpful subtitle
    greetings: [
      "Hope your day's going well",
      "Still going strong?",
      "How's the day treating you?",
      "Productive day so far?",
      "Afternoon check-in",
      "Keeping busy?",
      "Hope it's been a good one",
      "Almost there",
    ],
    subtitles: [
      "How can I help?",
      "What do you need?",
      "Let's figure it out together",
      "What can I take off your plate?",
      "Let me help with that",
      "What's the challenge today?",
      "What can I assist with?",
      "What's slowing you down?",
    ],
  },
];

export const EVENING_GROUPS: ContextGroup[] = [
  {
    // Wind-down: easing off, closing-out subtitle
    greetings: [
      "Good evening",
      "Evening",
      "Winding down?",
      "Time to wind down",
      "The day is almost done",
      "Settling in for the evening",
      "End of day mode",
      "Nearly there",
      "Almost time to rest",
    ],
    subtitles: [
      "Time to relax a bit?",
      "What's wrapping up today?",
      "Anything to tie up before tomorrow?",
      "What's left on the list?",
      "How can I help you close out the day?",
      "Let's wrap things up",
      "What's still on your mind?",
      "Evening thoughts?",
    ],
  },
  {
    // Reflective: introspective greeting, thoughtful subtitle
    greetings: [
      "How was your day?",
      "Evening thoughts?",
      "Hello there",
      "Welcome back",
      "Hope the day was good to you",
      "Good to see you this evening",
      "Long day?",
      "Made it through another one",
    ],
    subtitles: [
      "What's on your mind?",
      "Want to talk through something?",
      "Let's unpack it",
      "What stood out today?",
      "Something on your mind from today?",
      "I'm here if you want to think out loud",
      "Want to reflect on something?",
      "Let's make sense of it",
    ],
  },
  {
    // Still productive: evening energy, task-focused subtitle
    greetings: [
      "Evening, superstar",
      "Still going?",
      "The evening shift",
      "Golden hour productivity",
      "Wrapping up something important?",
      "Making the most of the evening?",
      "Evening hustle",
      "Burning that evening energy?",
    ],
    subtitles: [
      "What are we working on?",
      "Let's get things done",
      "What's the mission tonight?",
      "What needs finishing?",
      "Let's knock it out",
      "What are we tackling?",
      "Let's make the evening count",
      "What's left to do?",
    ],
  },
];

export const NIGHT_GROUPS: ContextGroup[] = [
  {
    // Night owl: can't sleep vibe, low-key curious subtitle
    greetings: [
      "Still up?",
      "Can't sleep?",
      "Late night?",
      "Hello, night owl",
      "The world's quiet, you're not",
      "Night owl mode",
      "Midnight wanderer",
      "Up late again?",
    ],
    subtitles: [
      "Let's use the time well",
      "What's keeping you up?",
      "Might as well be productive",
      "What's on your mind at this hour?",
      "Night owls get things done",
      "Something you can't stop thinking about?",
      "What are we exploring?",
      "What's on your mind?",
    ],
  },
  {
    // Midnight focus: dedicated work session, driven subtitle
    greetings: [
      "Burning the midnight oil?",
      "Night shift activated",
      "Working while the world sleeps",
      "Deep night focus",
      "Midnight work session",
      "The late shift",
      "Dedicated to the craft",
      "No sleep till it's done?",
    ],
    subtitles: [
      "Let's get to work",
      "Deep focus time",
      "What's the mission?",
      "Distraction-free zone",
      "Let's make progress",
      "What are we building?",
      "The best work happens at night",
      "Let's power through",
    ],
  },
  {
    // Late night curiosity: inspired, ideas-flowing greeting, exploratory subtitle
    greetings: [
      "Quiet hours, big ideas",
      "Moonlight inspiration?",
      "Stars are out, ideas are flowing",
      "The best ideas come at night",
      "Midnight inspiration?",
      "After-hours adventure",
      "Late night vibes",
      "Night brings clarity",
    ],
    subtitles: [
      "What are you thinking about?",
      "Something on your mind?",
      "Let's dive into something",
      "Curiosity doesn't sleep",
      "What's the big idea?",
      "Let's explore it",
      "Something sparked your curiosity?",
      "Let's follow the thought",
    ],
  },
];
