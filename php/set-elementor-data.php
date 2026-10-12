<?php
/**
 * Writes Elementor document data onto a page.
 *
 * Run through WP-CLI so it executes inside a loaded WordPress:
 *   wp eval-file php/set-elementor-data.php <post_id> <payload.json> --path=<site>
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `wp post meta update <id> _elementor_data '<json>'` does not work. WordPress
 * runs wp_unslash() on every meta write, which strips the backslashes out of
 * the JSON and leaves Elementor with an unparseable document — the page then
 * renders blank or as "unknown element" in the editor. The fix is to apply
 * wp_slash() first, which only works from inside PHP.
 *
 * The payload file is JSON: { "elements": [...], "page_settings": {...} }
 */

if ( ! defined( 'ABSPATH' ) ) {
	WP_CLI::error( 'This script must be run through `wp eval-file`.' );
}

// WP-CLI exposes trailing arguments to eval-file as $args.
if ( count( $args ) < 2 ) {
	WP_CLI::error( 'Usage: wp eval-file set-elementor-data.php <post_id> <payload.json>' );
}

list( $post_id, $payload_path ) = $args;
$post_id = (int) $post_id;

if ( ! $post_id || ! get_post( $post_id ) ) {
	WP_CLI::error( "Post {$post_id} does not exist." );
}
if ( ! file_exists( $payload_path ) ) {
	WP_CLI::error( "Payload file not found: {$payload_path}" );
}

$raw     = file_get_contents( $payload_path );
$payload = json_decode( $raw, true );

if ( JSON_ERROR_NONE !== json_last_error() ) {
	WP_CLI::error( 'Payload is not valid JSON: ' . json_last_error_msg() );
}
if ( ! isset( $payload['elements'] ) || ! is_array( $payload['elements'] ) ) {
	WP_CLI::error( 'Payload is missing an "elements" array.' );
}

// Re-encode from the decoded structure so what lands in the database is
// canonical JSON, not whatever formatting the generator happened to emit.
$elements_json = wp_json_encode( $payload['elements'] );
if ( false === $elements_json ) {
	WP_CLI::error( 'Could not re-encode the elements array.' );
}

// The wp_slash() call is the entire point of this file. Do not remove it.
update_post_meta( $post_id, '_elementor_data', wp_slash( $elements_json ) );
update_post_meta( $post_id, '_elementor_edit_mode', 'builder' );
update_post_meta( $post_id, '_elementor_template_type', 'wp-page' );
update_post_meta(
	$post_id,
	'_elementor_version',
	defined( 'ELEMENTOR_VERSION' ) ? ELEMENTOR_VERSION : '3.0.0'
);

if ( ! empty( $payload['page_settings'] ) && is_array( $payload['page_settings'] ) ) {
	update_post_meta( $post_id, '_elementor_page_settings', $payload['page_settings'] );
}

// Elementor caches generated CSS per post; stale cache shows the old layout.
if ( class_exists( '\Elementor\Plugin' ) && isset( \Elementor\Plugin::$instance->files_manager ) ) {
	\Elementor\Plugin::$instance->files_manager->clear_cache();
}

// Read it back and confirm it round-trips, so a silent corruption fails loudly
// here rather than showing up as a blank page much later.
$stored  = get_post_meta( $post_id, '_elementor_data', true );
$decoded = json_decode( is_string( $stored ) ? $stored : '', true );

if ( JSON_ERROR_NONE !== json_last_error() || ! is_array( $decoded ) ) {
	WP_CLI::error(
		'Verification failed: _elementor_data did not survive the write as valid JSON.'
	);
}

WP_CLI::success(
	sprintf(
		'Wrote %d top-level element(s) to post %d.',
		count( $decoded ),
		$post_id
	)
);
