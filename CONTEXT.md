# Jev Feed Filter

A personal text filter for posts in X's For You and Following feeds and video recommendations on YouTube Home and watch pages, based on the reader's own written preferences.

## Language

**Post**:
A feed item assessed against Guidance: an X post or a YouTube Home or watch-page video recommendation,
including Shorts shelf cards.
For a video recommendation, the evidence is its rendered title and channel name, not the video, thumbnail, or transcript.

**Supported Feed**:
X's selected For You or Following feed, YouTube Home recommendations (including the Shorts shelf), or watch-page recommendations.
Other feeds, search results, subscriptions, video players, descriptions, and comments are outside the filtering scope.

**Guidance**:
The reader's written description of the content they want to see or avoid, including any quality
preferences and exceptions.
_Avoid_: Prompt, system prompt

**Assessment**:
A judgment of a post against the reader's guidance.
_Avoid_: Verdict, quality rating

**Filtering Probability**:
The estimated probability that a post should be filtered out according to the reader's guidance.
_Avoid_: Relevance score, confidence, correctness guarantee

**Filter Threshold**:
The filtering probability cutoff above which an assessed post qualifies for filtering.

**Pending Post**:
A post whose assessment has been requested but has not finished. Pending posts remain normally
visible, without a loading badge, cover, or reserved space; pending does not mean filtered.

**Unassessed Post**:
A post for which no assessment is available. Image-only posts are unassessed in the current scope;
unassessed does not mean unwanted.

**Filtered Post**:
A post whose filtering probability is above the Filter Threshold and which the reader has not
revealed.

**Hide Mode**:
How the filter presents filtered posts: Blur or Collapse.

**Blurred Post**:
A filtered post whose content is visually obscured in place but remains available to reveal.
_Avoid_: Deleted post, removed post

**Collapsed Post**:
A filtered post reduced to a slim placeholder bar with a Reveal control.
_Avoid_: Deleted post, removed post

**Reveal**:
The reader's action of making one blurred or collapsed post visible, without changing their
guidance or teaching the filter a preference.
_Avoid_: Approve, whitelist
