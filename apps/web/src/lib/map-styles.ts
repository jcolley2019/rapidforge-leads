/**
 * Google Maps styling matched to DESIGN_NOTES tokens — dark default
 * (background 228 20% 5%) and light (220 30% 97%), muted labels, POI
 * clutter off, water a hair cyan so the accent reads. JSON styles keep the
 * classic (non-cloud) styling path — no map ID required.
 */
export const DARK_MAP_STYLES: google.maps.MapTypeStyle[] = [
  { elementType: "geometry", stylers: [{ color: "#0d0f16" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#8b93a7" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#0a0b10" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  {
    featureType: "administrative",
    elementType: "geometry.stroke",
    stylers: [{ color: "#232636" }],
  },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#171a24" }] },
  {
    featureType: "road",
    elementType: "geometry.stroke",
    stylers: [{ visibility: "off" }],
  },
  {
    featureType: "road.highway",
    elementType: "geometry",
    stylers: [{ color: "#20242f" }],
  },
  {
    featureType: "road",
    elementType: "labels.text.fill",
    stylers: [{ color: "#6b7280" }],
  },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0e1720" }] },
  {
    featureType: "water",
    elementType: "labels.text.fill",
    stylers: [{ color: "#3f5561" }],
  },
  { featureType: "landscape", stylers: [{ color: "#0d0f16" }] },
];

export const LIGHT_MAP_STYLES: google.maps.MapTypeStyle[] = [
  { elementType: "geometry", stylers: [{ color: "#f4f6fa" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#5c6470" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#ffffff" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  {
    featureType: "administrative",
    elementType: "geometry.stroke",
    stylers: [{ color: "#d8dde6" }],
  },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
  {
    featureType: "road",
    elementType: "geometry.stroke",
    stylers: [{ color: "#e4e8ef" }],
  },
  {
    featureType: "road.highway",
    elementType: "geometry",
    stylers: [{ color: "#e9edf3" }],
  },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#d6e7ee" }] },
  { featureType: "landscape", stylers: [{ color: "#f4f6fa" }] },
];
