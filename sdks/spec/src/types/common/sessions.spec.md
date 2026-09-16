# ActiveSession

Represents an active login session for a user.


## Properties

id: string
  Unique session identifier.

userId: string
  The user this session belongs to.

createdAt: Date
  When the session was created.

isImpersonation: bool
  Whether this is an impersonation session (admin viewing as user).

agentName: string | null
  Set when the session was minted for an AI agent through the agent auth
  protocol (`POST /agent/register` + human approval on the `agentAuthConfirm`
  handler page). It is the agent's self-reported name and is shown to users so
  they can recognise and revoke the agent's session. `null` for regular
  sessions. Maps from the `agent_name` field of the sessions API.

lastUsedAt: Date | null
  When the session was last used for an API request.

isCurrentSession: bool
  Whether this is the session making the current request.

geoInfo: GeoInfo | null
  Geographic information about where the session was last used.


---

# GeoInfo

Geographic information derived from IP address.


## Properties

city: string | null
  City name, if detected.

region: string | null
  Region/state name, if detected.

country: string | null
  Country code (ISO 3166-1 alpha-2), if detected.

countryName: string | null
  Full country name, if detected.

latitude: number | null
  Approximate latitude.

longitude: number | null
  Approximate longitude.
