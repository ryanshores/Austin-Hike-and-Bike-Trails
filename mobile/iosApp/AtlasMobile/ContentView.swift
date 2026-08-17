import AtlasShared
import SwiftUI

struct ContentView: View {
    private let greeting = AtlasGreeting()

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "figure.outdoor.cycle")
                .font(.system(size: 44))
                .foregroundStyle(.green)
            Text(greeting.message())
                .font(.title2.weight(.semibold))
            Text("Native iOS host, shared Kotlin foundation")
                .foregroundStyle(.secondary)
        }
        .padding()
    }
}
