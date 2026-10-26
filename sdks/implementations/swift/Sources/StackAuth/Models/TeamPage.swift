import Foundation

/// One page of teams from `GET /teams`.
///
/// With a `limit` (at most 200), `nextCursor` is set when there are more teams; pass it back as `cursor` (together with
/// `limit`) to fetch the next page. Without a `limit`, the backend returns every matching team, or a 400 error past 500.
public struct TeamPage<T: Sendable>: Sendable {
    public let items: [T]
    public let nextCursor: String?
}

/// Builds the `GET /teams` path. The backend rejects `cursor` without `limit`.
func teamListPath(
    userId: String?,
    limit: Int?,
    cursor: String?,
    query: String?,
    orderBy: String?,
    descending: Bool?
) -> String {
    var params: [(String, String)] = []
    if let userId = userId { params.append(("user_id", userId)) }
    if let limit = limit { params.append(("limit", String(limit))) }
    if let cursor = cursor { params.append(("cursor", cursor)) }
    if let query = query { params.append(("query", query)) }
    if let orderBy = orderBy { params.append(("order_by", orderBy)) }
    if let descending = descending { params.append(("desc", descending ? "true" : "false")) }
    if params.isEmpty { return "/teams" }

    // `.urlQueryAllowed` keeps `&`, `=`, and `+`, which would change the meaning of free-text `query` values.
    var allowed = CharacterSet.urlQueryAllowed
    allowed.remove(charactersIn: "&=+?#")
    let encode = { (value: String) in value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value }
    return "/teams?" + params.map { "\(encode($0.0))=\(encode($0.1))" }.joined(separator: "&")
}

func parseTeamPage<T: Sendable>(data: Data, makeTeam: ([String: Any]) -> T) throws -> TeamPage<T> {
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let items = json["items"] as? [[String: Any]] else {
        throw StackAuthError(code: "parse_error", message: "Failed to parse team list response")
    }
    let pagination = json["pagination"] as? [String: Any]
    return TeamPage(
        items: items.map(makeTeam),
        nextCursor: pagination?["next_cursor"] as? String
    )
}
