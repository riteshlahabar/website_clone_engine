<?php
/**
 * Applies the brand palette and fonts to Elementor's global kit.
 *
 *   wp eval-file php/set-elementor-kit.php <payload.json> --path=<site>
 *
 * The kit is a hidden `elementor_library` post whose `_elementor_page_settings`
 * meta holds the site-wide design tokens. Writing here is what makes the brand
 * apply everywhere, including to sections the builder did not generate — and it
 * is the only way the chosen fonts take effect at all, since individual widgets
 * inherit typography rather than declaring it.
 *
 * Payload JSON:
 *   { "colors": { "primary","secondary","text","accent" },
 *     "fonts":  { "heading","body" } }
 */

if ( ! defined( 'ABSPATH' ) ) {
	WP_CLI::error( 'This script must be run through `wp eval-file`.' );
}
if ( empty( $args[0] ) || ! file_exists( $args[0] ) ) {
	WP_CLI::error( 'Usage: wp eval-file set-elementor-kit.php <payload.json>' );
}

$payload = json_decode( file_get_contents( $args[0] ), true );
if ( JSON_ERROR_NONE !== json_last_error() ) {
	WP_CLI::error( 'Payload is not valid JSON: ' . json_last_error_msg() );
}

$colors  = $payload['colors'] ?? [];
$fonts   = $payload['fonts'] ?? [];
$heading = $fonts['heading'] ?? 'Poppins';
$body    = $fonts['body'] ?? 'Inter';

$kit_id = (int) get_option( 'elementor_active_kit' );
if ( ! $kit_id || ! get_post( $kit_id ) ) {
	WP_CLI::error( 'No active Elementor kit found. Is Elementor activated?' );
}

$settings = get_post_meta( $kit_id, '_elementor_page_settings', true );
if ( ! is_array( $settings ) ) {
	$settings = [];
}

// Global Colours. The four _id values are Elementor's own defaults, so existing
// widgets already bound to a global colour pick these up automatically.
$settings['system_colors'] = [
	[ '_id' => 'primary',   'title' => 'Primary',   'color' => $colors['primary']   ?? '#0F766E' ],
	[ '_id' => 'secondary', 'title' => 'Secondary', 'color' => $colors['secondary'] ?? '#134E4A' ],
	[ '_id' => 'text',      'title' => 'Text',      'color' => $colors['text']      ?? '#1F2937' ],
	[ '_id' => 'accent',    'title' => 'Accent',    'color' => $colors['accent']    ?? '#F59E0B' ],
];

$typography = static function ( $id, $title, $family, $weight ) {
	return [
		'_id'                      => $id,
		'title'                    => $title,
		'typography_typography'    => 'custom',
		'typography_font_family'   => $family,
		'typography_font_weight'   => $weight,
	];
};

// Global Fonts.
$settings['system_typography'] = [
	$typography( 'primary',   'Primary',   $heading, '600' ),
	$typography( 'secondary', 'Secondary', $heading, '500' ),
	$typography( 'text',      'Text',      $body,    '400' ),
	$typography( 'accent',    'Accent',    $body,    '500' ),
];

// Theme Style: body copy and every heading level. Without these the theme's own
// fonts win and the brand fonts appear to do nothing.
$settings['body_typography_typography']  = 'custom';
$settings['body_typography_font_family'] = $body;
$settings['body_typography_font_weight'] = '400';

foreach ( [ 'h1', 'h2', 'h3', 'h4', 'h5', 'h6' ] as $tag ) {
	$settings[ "{$tag}_typography_typography" ]  = 'custom';
	$settings[ "{$tag}_typography_font_family" ] = $heading;
	$settings[ "{$tag}_typography_font_weight" ] = '700';
}

update_post_meta( $kit_id, '_elementor_page_settings', wp_slash( $settings ) );

// Regenerate CSS, or the kit's stylesheet keeps the previous palette.
if ( class_exists( '\Elementor\Plugin' ) && isset( \Elementor\Plugin::$instance->files_manager ) ) {
	\Elementor\Plugin::$instance->files_manager->clear_cache();
}

// Verify the write survived rather than trusting it.
$stored = get_post_meta( $kit_id, '_elementor_page_settings', true );
if ( ! is_array( $stored ) || empty( $stored['system_colors'] ) ) {
	WP_CLI::error( 'Verification failed: kit settings did not persist.' );
}

WP_CLI::success(
	sprintf(
		'Kit %d updated — %d colours, headings in %s, body in %s.',
		$kit_id,
		count( $stored['system_colors'] ),
		$heading,
		$body
	)
);
