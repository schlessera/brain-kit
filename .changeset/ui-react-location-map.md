---
"@schlessera/brain-ui-react": minor
"@schlessera/brain-ui-kit": patch
---

The `get_current_location` result is a map. The card renders the kit's
`MapView` with the fix as its pin, widens the view when the accuracy is
coarse, and fetches the shoreline and roads around the fix from the server's
`/geo/coastline` route, credited to OpenStreetMap when geometry is drawn. With
no server, an older server or an outage the map keeps its pin, graticule and
scale bar. The API client gains `geoCoastline(bbox, { width, signal })`, and
the kit exports the `MapLand` type beside `MapPath` and `MapPin`.
